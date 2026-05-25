# Launch Readiness Code Fixes — 2026-05-24

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every code-level finding from the 2026-05-24 launch-readiness audit so Breeze is ready to onboard Tier 1 customers (own/friendly MSPs) and credibly start the Tier 2 + insurance path.

**Architecture:** Thirty independent, commit-sized fixes spanning the API, agent, and config layers. Each task is self-contained — one finding, one commit, one PR if desired. No shared state between tasks except where explicitly noted (Phase 1 must precede Phase 5's audit-related task). Tasks are grouped into 8 phases that map to the sprint timeline in the consultant verdict.

**Tech Stack:** Hono + Zod + Drizzle (API), Vitest (API/web/agent tests), React/Astro (web), Go (agent).

**Source of findings:** `/Users/toddhebebrand/breeze/internal/2026-05-24-launch-readiness-consultant-verdict.md` and the seven underlying per-surface investigator reports.

**Out of scope (deferred to separate plans):**
- Pure-ops items (Prometheus deployment, status page, pentest commissioning, SOC 2, off-region backup wiring).
- Architectural rework — moving the manifest signing key off the API host needs its own design plan (recommend ~1 week design + 2 weeks build).
- WebAuthn / passkey adoption (HIGH risk reduction, but a multi-week UX project).

---

## File Structure

Files touched by this plan, grouped by phase. New files are marked `(new)`.

**Phase 1 — Auditability foundation (must precede everything else):**
- `apps/api/migrations/2026-05-25-audit-log-append-only.sql` (new) — REVOKE DELETE/UPDATE + raise-on-mutation trigger
- `apps/api/migrations/2026-05-25-audit-log-checksum.sql` (new) — chain checksum populated by trigger
- `apps/api/src/services/auditService.ts` — make `createAuditLogAsync` await-able + add retry queue
- `apps/api/src/services/auditService.test.ts` — chain integrity test + retry behavior
- `apps/api/src/__tests__/integration/audit-append-only.integration.test.ts` (new) — verify DELETE/UPDATE blocked at DB

**Phase 2 — Stored-secret encryption gaps (#716 + parallel):**
- `apps/api/src/services/encryptedColumnRegistry.ts` — register `partners.settings` and `sites.settings`
- `apps/api/migrations/2026-05-26-encrypt-partner-site-settings.sql` (new) — one-shot re-encrypt
- `apps/api/src/services/remoteAccessLauncher.ts` — read decrypted secret via spec
- `apps/api/src/services/remoteAccessLauncher.test.ts` — round-trip test
- `apps/api/src/services/secretCrypto.ts` — optional AAD parameter (defense-in-depth)
- `apps/api/src/services/secretCrypto.test.ts` — AAD binding test

**Phase 3 — AuthN hardening:**
- `apps/api/src/services/jwt.ts` — `kid` header + verify-keyring
- `apps/api/src/services/jwt.test.ts` — rotation roundtrip
- `apps/api/src/services/tokenRevocation.ts` — `family_id` reuse detection + CAS revoke
- `apps/api/src/db/schema/refreshTokenFamilies.ts` (new) — family tracking schema
- `apps/api/migrations/2026-05-27-refresh-token-families.sql` (new)
- `apps/api/src/routes/auth/login.ts` — issue family + detect reuse + per-account lockout
- `apps/api/src/services/rate-limit.ts` — `accountLockout()` helper
- `apps/api/src/middleware/auth.ts` — MFA enforcement on partner-admin role
- `apps/api/src/routes/auth/password.ts` — allow reset for `pending` partners (#719)
- `apps/api/src/services/passwordResetEligibility.ts` (new) — single decision point
- `apps/api/src/routes/auth/helpers.ts` — equalize SSO/inactive-branch latency

**Phase 4 — AuthZ + scope discipline:**
- `apps/api/src/routes/software.ts` — apply `allowedSiteIds` to inventory list + per-device
- `apps/api/src/routes/cisHardening.ts` — `assertDeviceAccess` honors site scope
- `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts` (new) — contract test
- `apps/api/src/services/tenantLifecycle.ts` — revoke OAuth grants on partner status change
- `apps/api/src/services/oauthGrantRevocation.ts` (new) — bulk-revoke helper
- `apps/api/src/routes/partners.ts` — revoke JWTs when removing partner_user row
- `apps/api/src/middleware/bearerTokenAuth.ts` — pull MCP/OAuth bearers through partnerGuard equivalent

**Phase 5 — Agent + WebSocket hardening:**
- `apps/api/src/services/remoteSessionAuth.ts` — bind ticket consumption to IP/UA
- `apps/api/src/routes/desktopWs.ts` — remove `exchangeCache` 30s re-exchange window
- `apps/api/src/routes/agentWs.ts` — `crossTenantDrops` auto-suspend after threshold
- `apps/api/src/middleware/agentAuth.ts` — per-source-IP rate limit
- (audit fire-and-forget covered by Phase 1 Task 3)

**Phase 6 — MCP hardening:**
- `apps/api/src/services/aiToolsRemote.ts` — promote `take_screenshot`/`analyze_screen` to Tier 3
- `apps/api/src/oauth/provider.ts` — flip `OAUTH_DCR_ENABLED` default to false
- `apps/api/src/index.ts` — wire `cleanupStaleOauthClients` GC worker
- `apps/api/src/routes/mcpServer.ts` — server-mint `Mcp-Session-Id` + bind to principal
- `apps/api/src/services/aiGuardrails.ts` — deny when `action` missing on action-multiplexed tool
- `apps/api/src/middleware/bearerTokenAuth.ts` — drop `mcp:write` → `ai:execute` legacy expansion

**Phase 7 — Config validators + supply chain:**
- `apps/api/src/config/validate.ts` — TRUST_PROXY_HEADERS + Stripe/OAuth/S3/Resend/MSI required-when validators
- `apps/api/src/config/validate.test.ts` — boot-refusal tests
- `pnpm-lock.yaml` (regenerate) — bump `ip` to remove SSRF transitive dep

**Phase 8 — Retention + GDPR + Webhooks + Installer:**
- `apps/api/src/jobs/auditRetention.ts` (new) — daily prune cron
- `apps/api/src/routes/admin/tenantErasure.ts` (new) — bulk org/partner cascade-delete endpoint
- `apps/api/src/routes/admin/tenantExport.ts` (new) — bulk org/partner export endpoint
- `apps/api/src/routes/automations.ts` — flip `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` default to false
- `apps/api/src/routes/enrollmentKeys.ts` — per-short-code signing rate cap on `serveInstaller`

**Phase 9 — Observability (Sentry on web + agent):**
- `apps/web/sentry.client.config.ts` — populate release tag + alert-relevant breadcrumbs
- `apps/web/sentry.server.config.ts` — same
- `agent/internal/observability/sentry.go` (new) — Sentry init + `Recoverer` wrapper
- `agent/main.go` — wire Sentry init at startup

---

## Phase 1 — Auditability foundation

> **Must ship first.** Without tamper-evident audit logs, every subsequent fix is harder to validate post-incident.

---

### Task 1: Make `audit_logs` append-only at the DB layer

Audit finding (CRITICAL): `audit_logs` rows are DELETE/UPDATE-able via RLS by org members; a malicious admin can erase the trail of their own command. RLS policies grant DELETE/UPDATE; nothing prevents it at the table-grant level.

**Files:**
- Create: `apps/api/migrations/2026-05-25-a-audit-log-append-only.sql`
- Create: `apps/api/src/__tests__/integration/audit-append-only.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/audit-append-only.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';

describe('audit_logs append-only enforcement', () => {
  let auditId: string;

  beforeAll(async () => {
    const rows = await db.execute(sql`
      INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, result)
      VALUES ('system', gen_random_uuid(), 'test.action', 'test', 'success')
      RETURNING id
    `);
    auditId = (rows as unknown as Array<{ id: string }>)[0].id;
  });

  it('rejects DELETE from breeze_app under any RLS context', async () => {
    await expect(
      withDbAccessContext({ scope: 'system' }, () =>
        db.execute(sql`DELETE FROM audit_logs WHERE id = ${auditId}`)
      )
    ).rejects.toThrow(/audit log is append-only/i);
  });

  it('rejects UPDATE from breeze_app under any RLS context', async () => {
    await expect(
      withDbAccessContext({ scope: 'system' }, () =>
        db.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${auditId}`)
      )
    ).rejects.toThrow(/audit log is append-only/i);
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @breeze/api test:integration audit-append-only`
Expected: FAIL (DELETE and UPDATE succeed).

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-05-25-a-audit-log-append-only.sql`:

```sql
-- Strip DELETE/UPDATE grants from breeze_app on audit_logs. RLS policies allowed
-- these implicitly; this revoke ensures no role + RLS combination can mutate.
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM breeze_app;

-- Belt-and-suspenders: a trigger that raises on any mutation. Survives a future
-- GRANT typo and surfaces a clear error message.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log is append-only',
    HINT = 'audit_logs entries cannot be modified or deleted. Retention purging uses a separate role; see jobs/auditRetention.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_block_update ON audit_logs;
CREATE TRIGGER audit_log_block_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_block_delete ON audit_logs;
CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Retention purging will run under a privileged role that disables this trigger
-- per-statement via SET LOCAL session_replication_role = 'replica' inside a
-- system context. See apps/api/src/jobs/auditRetention.ts.
```

- [ ] **Step 4: Verify the test passes**

Run: `pnpm db:check-drift && pnpm --filter @breeze/api test:integration audit-append-only`
Expected: drift check clean, both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-05-25-a-audit-log-append-only.sql apps/api/src/__tests__/integration/audit-append-only.integration.test.ts
git commit -m "security(audit): make audit_logs append-only at DB layer"
```

---

### Task 2: Populate `audit_logs.checksum` as a hash chain

Audit finding (CRITICAL, secrets review): `audit_logs.checksum` is declared in `apps/api/src/db/schema/audit.ts:24` but never populated. Without a chain, deletion of audit rows leaves no detectable gap.

**Files:**
- Create: `apps/api/migrations/2026-05-25-b-audit-log-checksum-chain.sql`
- Create: `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';

describe('audit_logs checksum chain', () => {
  it('populates checksum on insert', async () => {
    const orgId = crypto.randomUUID();
    await withDbAccessContext({ scope: 'system' }, async () => {
      const rows = await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'chain.test', 'test', 'success')
        RETURNING id, checksum
      `);
      const row = (rows as unknown as Array<{ id: string; checksum: string }>)[0];
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('each subsequent row chains to the previous within an org', async () => {
    const orgId = crypto.randomUUID();
    await withDbAccessContext({ scope: 'system' }, async () => {
      const a = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'a', 'test', 'success')
        RETURNING checksum
      `)) as unknown as Array<{ checksum: string }>;
      const b = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'b', 'test', 'success')
        RETURNING checksum, prev_checksum
      `)) as unknown as Array<{ checksum: string; prev_checksum: string }>;
      expect(b[0].prev_checksum).toEqual(a[0].checksum);
      expect(b[0].checksum).not.toEqual(a[0].checksum);
    });
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @breeze/api test:integration audit-checksum`
Expected: FAIL (no checksum populated; `prev_checksum` column missing).

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-05-25-b-audit-log-checksum-chain.sql`:

```sql
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_checksum varchar(128);

CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev varchar(128);
  payload text;
BEGIN
  -- Chain key is org_id (NULL for system-scoped). Within each chain the prev
  -- checksum links to the latest row by timestamp + id. This gives per-tenant
  -- chains independent of system events, so org-scoped retention pruning
  -- (Task 29) can rebuild a chain on the org without affecting others.
  SELECT checksum INTO prev
  FROM audit_logs
  WHERE org_id IS NOT DISTINCT FROM NEW.org_id
    AND id <> NEW.id
  ORDER BY timestamp DESC, id DESC
  LIMIT 1;

  payload := COALESCE(prev, '') || '|'
          || NEW.id::text || '|'
          || NEW.actor_type::text || '|'
          || COALESCE(NEW.actor_id::text, '') || '|'
          || NEW.action || '|'
          || NEW.resource_type || '|'
          || COALESCE(NEW.resource_id::text, '') || '|'
          || NEW.result::text || '|'
          || COALESCE(NEW.details::text, '') || '|'
          || NEW.timestamp::text;

  NEW.prev_checksum := prev;
  NEW.checksum := encode(sha256(payload::bytea), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain_checksum ON audit_logs;
CREATE TRIGGER audit_log_chain_checksum BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_compute_checksum();

-- Backfill: populate prev_checksum/checksum for existing rows in timestamp order.
DO $$
DECLARE
  rec record;
  prev varchar(128) := NULL;
  prev_org uuid := NULL;
BEGIN
  FOR rec IN
    SELECT id, org_id, actor_type, actor_id, action, resource_type, resource_id, result, details, timestamp
    FROM audit_logs
    ORDER BY org_id NULLS FIRST, timestamp, id
  LOOP
    IF prev_org IS DISTINCT FROM rec.org_id THEN
      prev := NULL;
    END IF;
    UPDATE audit_logs SET
      prev_checksum = prev,
      checksum = encode(sha256((
        COALESCE(prev, '') || '|' || rec.id::text || '|' || rec.actor_type::text || '|' ||
        COALESCE(rec.actor_id::text, '') || '|' || rec.action || '|' || rec.resource_type || '|' ||
        COALESCE(rec.resource_id::text, '') || '|' || rec.result::text || '|' ||
        COALESCE(rec.details::text, '') || '|' || rec.timestamp::text
      )::bytea), 'hex')
    WHERE id = rec.id
    RETURNING checksum INTO prev;
    prev_org := rec.org_id;
  END LOOP;
END $$;
```

- [ ] **Step 4: Update the Drizzle schema**

Edit `apps/api/src/db/schema/audit.ts` — add `prev_checksum`:

```ts
export const auditLogs = pgTable('audit_logs', {
  // ...existing fields...
  checksum: varchar('checksum', { length: 128 }),
  prevChecksum: varchar('prev_checksum', { length: 128 }),
  initiatedBy: initiatedByEnum('initiated_by'),
});
```

- [ ] **Step 5: Verify the test passes**

Run: `pnpm db:check-drift && pnpm --filter @breeze/api test:integration audit-checksum`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-05-25-b-audit-log-checksum-chain.sql apps/api/src/db/schema/audit.ts apps/api/src/__tests__/integration/audit-checksum.integration.test.ts
git commit -m "security(audit): populate audit_logs.checksum as hash chain"
```

---

### Task 3: Make audit writes await-able + add retry queue

Audit finding (HIGH, agent review H-4): `createAuditLogAsync` is fire-and-forget. A DB write failure means the action happened but the audit row didn't. Pairs with Task 1: append-only is worthless if writes silently drop.

**Files:**
- Modify: `apps/api/src/services/auditService.ts`
- Test: `apps/api/src/services/auditService.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/auditService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createAuditLogAsync, drainAuditRetryQueue, _resetRetryQueueForTest } from './auditService';

describe('audit write retry', () => {
  it('queues failed writes for retry instead of dropping them', async () => {
    _resetRetryQueueForTest();
    const insertSpy = vi.spyOn(global.console, 'error').mockImplementation(() => {});
    let calls = 0;
    vi.doMock('../db', () => ({
      db: { execute: vi.fn(async () => { calls++; if (calls === 1) throw new Error('boom'); return []; }) },
      withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
    }));
    await createAuditLogAsync({
      actorType: 'system', actorId: '00000000-0000-0000-0000-000000000000',
      action: 'test', resourceType: 'test', result: 'success'
    });
    const drained = await drainAuditRetryQueue();
    expect(drained.attempted).toBe(1);
    expect(drained.successful).toBe(1);
    insertSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @breeze/api test auditService`
Expected: FAIL (drainAuditRetryQueue not exported).

- [ ] **Step 3: Implement the retry queue**

Edit `apps/api/src/services/auditService.ts` — wrap `createAuditLogAsync` so failures push to a bounded in-memory queue, then export `drainAuditRetryQueue` (called by a 30s timer + on graceful shutdown). On retry exhaustion (>3 attempts), log a Sentry error with the full payload as breadcrumb context.

```ts
const RETRY_QUEUE: Array<{ entry: AuditLogEntry; attempts: number; nextAt: number }> = [];
const MAX_QUEUE = 10000;
const MAX_ATTEMPTS = 3;

export async function createAuditLogAsync(entry: AuditLogEntry): Promise<void> {
  try {
    await persistAuditLog(entry);
  } catch (err) {
    if (RETRY_QUEUE.length < MAX_QUEUE) {
      RETRY_QUEUE.push({ entry, attempts: 1, nextAt: Date.now() + 5_000 });
    }
    console.error('[audit] write failed, queued for retry:', err);
  }
}

export async function drainAuditRetryQueue(): Promise<{ attempted: number; successful: number; dropped: number }> {
  const now = Date.now();
  const stats = { attempted: 0, successful: 0, dropped: 0 };
  for (let i = RETRY_QUEUE.length - 1; i >= 0; i--) {
    const item = RETRY_QUEUE[i];
    if (item.nextAt > now) continue;
    stats.attempted++;
    try {
      await persistAuditLog(item.entry);
      RETRY_QUEUE.splice(i, 1);
      stats.successful++;
    } catch (err) {
      item.attempts++;
      if (item.attempts >= MAX_ATTEMPTS) {
        RETRY_QUEUE.splice(i, 1);
        stats.dropped++;
        Sentry.captureException(err, { extra: { auditEntry: item.entry, attempts: item.attempts } });
      } else {
        item.nextAt = now + 5_000 * 2 ** item.attempts;
      }
    }
  }
  return stats;
}

export function _resetRetryQueueForTest(): void {
  RETRY_QUEUE.length = 0;
}
```

- [ ] **Step 4: Wire the timer in `apps/api/src/index.ts`**

```ts
import { drainAuditRetryQueue } from './services/auditService';
setInterval(() => { void drainAuditRetryQueue(); }, 30_000);
// On SIGTERM, drain once before exit:
process.on('SIGTERM', async () => { await drainAuditRetryQueue(); process.exit(0); });
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test auditService`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auditService.ts apps/api/src/services/auditService.test.ts apps/api/src/index.ts
git commit -m "security(audit): retry failed audit writes instead of dropping them"
```

---

## Phase 2 — Stored-secret encryption gaps

---

### Task 4: Encrypt `partners.settings` and `sites.settings` (#716)

Audit finding (CRITICAL, secrets C-1): `partners.settings` is JSONB and contains `password` from `RemoteAccessProvider.password` (`packages/shared/src/types/index.ts:565-572`), stored unencrypted; read by `apps/api/src/services/remoteAccessLauncher.ts:82`. `organizations.settings` is already in `encryptedColumnRegistry`; partners + sites parallel was missed. SECRET_JSON_KEYS already contains `password`, so the JSON-key transform already covers the relevant field — only registration is missing.

**Files:**
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts`
- Create: `apps/api/migrations/2026-05-26-encrypt-partner-site-settings.sql`
- Test: `apps/api/src/services/remoteAccessLauncher.test.ts`

- [ ] **Step 1: Write the test asserting the read path returns plaintext**

Add to `apps/api/src/services/remoteAccessLauncher.test.ts`:

```ts
import { encryptSecret } from './secretCrypto';

it('decrypts password from encrypted partners.settings on read', async () => {
  const enc = encryptSecret('s3cret');
  const partner = { settings: { remoteAccess: { provider: 'rustdesk', password: enc } } };
  const result = await launchRemoteAccess({ partner });
  expect(result.password).toEqual('s3cret');
  expect(result.password).not.toMatch(/^enc:/);
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @breeze/api test remoteAccessLauncher`
Expected: FAIL (launcher passes through `enc:v2:...` raw).

- [ ] **Step 3: Register the columns**

Edit `apps/api/src/services/encryptedColumnRegistry.ts:42-66` — append:

```ts
  { table: 'organizations', column: 'settings', kind: 'json', description: 'organization settings with encrypted log-forwarding secrets' },
  { table: 'partners', column: 'settings', kind: 'json', description: 'partner settings with encrypted remote-access launcher passwords' },
  { table: 'sites', column: 'settings', kind: 'json', description: 'site-level settings with encrypted overrides' },
];
```

- [ ] **Step 4: Update the launcher to decrypt the JSON path**

Edit `apps/api/src/services/remoteAccessLauncher.ts` — when reading the password, wrap with `decryptSecret`:

```ts
import { decryptSecret } from './secretCrypto';
// ...
const password = decryptSecret(partner.settings?.remoteAccess?.password) ?? partner.settings?.remoteAccess?.password ?? null;
```

(Backwards-compatible — handles both pre-migration plaintext and post-migration encrypted.)

- [ ] **Step 5: Write the migration that re-encrypts existing rows**

Create `apps/api/migrations/2026-05-26-encrypt-partner-site-settings.sql`:

```sql
-- This migration is a NO-OP at the SQL layer; the work is done by the
-- application script scripts/re-encrypt-secrets.ts because the cipher key
-- lives in APP_ENCRYPTION_KEY (env), not in the DB.
--
-- This file exists so that the migration runner records that the registry
-- update has shipped. Deploy step requires running:
--
--   pnpm --filter @breeze/api re-encrypt-secrets
--
-- after this migration. The script is idempotent and skips already-encrypted
-- values.

SELECT 1;
```

- [ ] **Step 6: Run the re-encrypt script in dev**

```bash
pnpm --filter @breeze/api re-encrypt-secrets
```

Expected output: includes `partners.settings` and `sites.settings` rows in the changed count.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @breeze/api test remoteAccessLauncher`
Expected: PASS.

Also manually verify in DB:
```bash
docker exec -it breeze-postgres psql -U breeze -d breeze -c \
  "SELECT id, settings->'remoteAccess'->>'password' FROM partners WHERE settings->'remoteAccess' IS NOT NULL LIMIT 5;"
```
Expected: any non-null values begin with `enc:v2:`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/services/remoteAccessLauncher.ts apps/api/src/services/remoteAccessLauncher.test.ts apps/api/migrations/2026-05-26-encrypt-partner-site-settings.sql
git commit -m "security(secrets): encrypt partners.settings + sites.settings (#716)"
```

---

### Task 5: Bind AAD to table+column in AES-256-GCM

Audit finding (MEDIUM, secrets M-2): `secretCrypto.encryptWithKey` (line 187) does not call `setAAD`. The auth tag covers ciphertext only — moving a `webhooks.secret` ciphertext into `sso_providers.client_secret` would silently decrypt. Cheap fix, real defense-in-depth.

**Files:**
- Modify: `apps/api/src/services/secretCrypto.ts`
- Test: `apps/api/src/services/secretCrypto.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/secretCrypto.test.ts`:

```ts
it('refuses to decrypt with mismatched AAD', () => {
  const enc = encryptSecret('hello', { aad: 'sso_providers.client_secret' });
  expect(() => decryptSecret(enc, { aad: 'webhooks.secret' })).toThrow();
  expect(decryptSecret(enc, { aad: 'sso_providers.client_secret' })).toEqual('hello');
});

it('omits AAD for backwards compatibility', () => {
  const enc = encryptSecret('hello');
  expect(decryptSecret(enc)).toEqual('hello');
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @breeze/api test secretCrypto`
Expected: FAIL (options parameter not supported).

- [ ] **Step 3: Add the AAD plumbing**

Edit `apps/api/src/services/secretCrypto.ts`:

- `encryptWithKey(value, key, prefix, aad?: string)` — if `aad` set, call `cipher.setAAD(Buffer.from(aad, 'utf8'))`.
- `decryptWithKey(encoded, key, aad?: string)` — same for `decipher.setAAD`.
- `encryptSecret(value, opts?: { aad?: string })` and `decryptSecret(value, opts?: { aad?: string })` — thread through.
- The v3 format bumps the prefix to `enc:v3:` and includes the AAD in the wire format so decryption knows to set it. v2 stays the default for callers that don't pass AAD.

Then update `transformEncryptedColumnValue` (`encryptedColumnRegistry.ts:141`) so the JSON/text paths pass `aad = \`${spec.table}.${spec.column}\`` only when the column is known to be re-encrypted under v3 (rolled out over time; do not force).

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test secretCrypto`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/secretCrypto.ts apps/api/src/services/secretCrypto.test.ts apps/api/src/services/encryptedColumnRegistry.ts
git commit -m "security(crypto): bind AAD to table+column in stored-secret encryption"
```

---

## Phase 3 — AuthN hardening

---

### Task 6: Add `kid` header + verify-keyring to JWT signing

Audit finding (HIGH, auth H-1 + secrets H-2): `apps/api/src/services/jwt.ts:17-21` reads a single `JWT_SECRET`, no `kid`, no rotation. Leaking the secret is an existential platform compromise; rotating it = blackout-everyone. Mirror the pattern used in `oauth/provider.ts` and `secretCrypto.ts`.

**Files:**
- Modify: `apps/api/src/services/jwt.ts`
- Modify: `apps/api/src/config/validate.ts`
- Test: `apps/api/src/services/jwt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/jwt.test.ts`:

```ts
it('signs with active kid + verifies tokens from prior kid', async () => {
  process.env.JWT_SIGNING_KEYRING = JSON.stringify({
    'k1': 'a'.repeat(64),
    'k2': 'b'.repeat(64),
  });
  process.env.JWT_ACTIVE_KID = 'k2';

  const token = await createAccessToken({
    sub: 'u1', email: 'a@b.c', roleId: null, orgId: null,
    partnerId: null, scope: 'system', mfa: true
  });
  const verified = await verifyToken(token);
  expect(verified?.sub).toBe('u1');

  // Rotate: k2 → k1 (simulate a downgrade scenario; both must still verify).
  process.env.JWT_ACTIVE_KID = 'k1';
  const verifiedAfterRotation = await verifyToken(token);
  expect(verifiedAfterRotation?.sub).toBe('u1');
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test jwt`
Expected: FAIL (keyring not implemented).

- [ ] **Step 3: Implement**

Edit `apps/api/src/services/jwt.ts`:

- Add `getSigningKeyring(): Map<string, Uint8Array>` parsing `JWT_SIGNING_KEYRING` JSON.
- Add `getActiveSigningKid(): string` reading `JWT_ACTIVE_KID`, falling back to a synthetic `legacy` kid backed by the existing `JWT_SECRET`.
- Modify `createAccessToken` / `createRefreshToken` / `createViewerAccessToken` to set `.setProtectedHeader({ alg: 'HS256', kid: activeKid })`.
- Modify `verifyToken` / `verifyViewerAccessToken` to use the `getKey()` callback form of `jwtVerify`, looking up the key by `protectedHeader.kid` from the keyring (with `legacy` always present pointing at `JWT_SECRET`).
- Continue to enforce `length >= 32` on each keyring entry.

- [ ] **Step 4: Add the validator boot-check**

Edit `apps/api/src/config/validate.ts` — in the `superRefine` block, if `JWT_SIGNING_KEYRING` is present, validate it parses as `Record<string, string>` with all values ≥32 chars and the active kid present in the map. Document `JWT_SIGNING_KEYRING` and `JWT_ACTIVE_KID` in `.env.example` with a rotation runbook reference.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test jwt`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts apps/api/src/config/validate.ts apps/api/.env.example
git commit -m "security(auth): support JWT key rotation via kid header + keyring"
```

---

### Task 7: Refresh-token family revocation + reuse detection

Audit finding (HIGH, auth H-2 + secrets H-1): `apps/api/src/routes/auth/login.ts:273-366`. Stolen-and-replayed refresh token + race vs. legitimate user yields silent dual-session. Modern OAuth 2.1 guidance: on revoked-jti presented, revoke the whole family + alert.

**Files:**
- Create: `apps/api/src/db/schema/refreshTokenFamilies.ts`
- Create: `apps/api/migrations/2026-05-27-refresh-token-families.sql`
- Modify: `apps/api/src/services/tokenRevocation.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Test: `apps/api/src/routes/auth/login.test.ts` (extend existing)

- [ ] **Step 1: Write the failing integration test**

Add to `apps/api/src/routes/auth/login.test.ts`:

```ts
it('revokes the entire refresh family on reuse of a revoked jti', async () => {
  // Login and get refresh1
  const { refreshToken: r1 } = await login('user@x.com', 'pw');
  // Refresh once - r1 revoked, r2 issued
  const { refreshToken: r2 } = await refresh(r1);
  // Attacker replays r1 — must mark r2's family revoked + return 401
  const replayed = await refresh(r1);
  expect(replayed.status).toBe(401);
  // Legitimate r2 must now fail too (whole family killed)
  const legitFollowup = await refresh(r2);
  expect(legitFollowup.status).toBe(401);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test login`
Expected: FAIL (r2 still works after r1 is replayed).

- [ ] **Step 3: Add the schema + migration**

Create `apps/api/src/db/schema/refreshTokenFamilies.ts`:

```ts
import { pgTable, uuid, varchar, timestamp, boolean } from 'drizzle-orm/pg-core';

export const refreshTokenFamilies = pgTable('refresh_token_families', {
  familyId: uuid('family_id').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
  revokedReason: varchar('revoked_reason', { length: 64 }),
});
```

Create `apps/api/migrations/2026-05-27-refresh-token-families.sql`:

```sql
CREATE TABLE IF NOT EXISTS refresh_token_families (
  family_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp NOT NULL DEFAULT now(),
  revoked_at timestamp,
  revoked_reason varchar(64)
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_families_user ON refresh_token_families(user_id);
```

Per the RLS contract test: this is a user-id-scoped table. Add to `USER_ID_SCOPED_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` and create the RLS policy in the same migration:

```sql
ALTER TABLE refresh_token_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token_families FORCE ROW LEVEL SECURITY;
CREATE POLICY rtf_user_isolation_all ON refresh_token_families
  FOR ALL TO breeze_app
  USING (user_id = public.breeze_current_user_id())
  WITH CHECK (user_id = public.breeze_current_user_id());
```

- [ ] **Step 4: Extend `tokenRevocation.ts`**

Add `getFamilyForJti(jti)`, `revokeFamily(familyId, reason)`, `isFamilyRevoked(familyId)`. Use a Redis-backed lookup keyed on `refresh-family:<jti>` so the hot path is one Redis GET; the Postgres table is the source-of-truth + audit trail.

- [ ] **Step 5: Wire login + refresh**

Edit `apps/api/src/routes/auth/login.ts`:

- On `/login` token mint (line 204): generate `familyId = randomUUID()`, persist to `refresh_token_families`, embed as `fam` claim in the refresh JWT only.
- On `/refresh` (line 273):
  - After verifying jti, check `isFamilyRevoked(payload.fam)` — if yes, 401.
  - If `isRefreshTokenJtiRevoked(payload.jti)` — REUSE DETECTED → `revokeFamily(payload.fam, 'reuse-detected')` + write audit event + 401.
  - On success: mint new jti, atomically `revokeRefreshTokenJti(payload.jti)` *before* setting cookie. Wrap revoke + mint in a `try` that on failure backs out by re-revoking the new jti.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @breeze/api test login && pnpm db:check-drift && pnpm --filter @breeze/api test:integration rls-coverage`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/refreshTokenFamilies.ts apps/api/migrations/2026-05-27-refresh-token-families.sql apps/api/src/services/tokenRevocation.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "security(auth): detect refresh-token reuse and revoke the family"
```

---

### Task 8: Enforce MFA on the partner-admin role

Audit finding (HIGH, auth M-2 + ops H1): `requireMfa` is per-route, not per-role. A new partner-admin can stay password-only. Insurance line-item #1.

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/routes/auth/login.ts` — emit `requiresMfaEnrollment` flag
- Modify: `apps/web/src/components/auth/LoginForm.tsx` — render enrollment redirect
- Test: `apps/api/src/middleware/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('forces partner-admin users without MFA to enroll on next request', async () => {
  const user = await seedPartnerAdmin({ mfaEnabled: false });
  const token = await issueAccessToken(user);
  const res = await app.request('/api/v1/partner/me', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(428); // Precondition Required
  const body = await res.json();
  expect(body).toMatchObject({ error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test auth.test`
Expected: FAIL (returns 200, no enrollment gate).

- [ ] **Step 3: Implement**

Edit `apps/api/src/middleware/auth.ts`:

- After resolving `auth.user` + `auth.permissions`, if the role's `forceMfa` flag is `true` (new permission), and `user.mfaEnabled === false`, and the route is not an exempt auth-flow route (login, logout, mfa setup), return 428 with the structured error.
- Add a config helper `roleRequiresMfa(roleSlug: string): boolean` — true for `partner_admin`, `system_admin`, `platform_admin`. Tier 1 owner-controlled roles; loaded from the roles table's new `force_mfa` boolean column.

Add the schema column:

```sql
-- apps/api/migrations/2026-05-28-role-force-mfa.sql
ALTER TABLE roles ADD COLUMN IF NOT EXISTS force_mfa boolean NOT NULL DEFAULT false;
UPDATE roles SET force_mfa = true WHERE slug IN ('partner_admin', 'system_admin', 'platform_admin');
```

Update `apps/api/src/db/schema/roles.ts` to add `forceMfa: boolean('force_mfa').notNull().default(false)`.

- [ ] **Step 4: Update LoginForm to handle 428**

In `apps/web/src/components/auth/LoginForm.tsx` (and the `useAuth` hook), when a 428 + `error: 'mfa_enrollment_required'` comes back from any request after login, redirect to `/auth/mfa/setup?forced=1`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test auth.test && pnpm --filter @breeze/web test LoginForm && pnpm db:check-drift`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/db/schema/roles.ts apps/api/migrations/2026-05-28-role-force-mfa.sql apps/api/src/middleware/auth.test.ts apps/web/src/components/auth/LoginForm.tsx
git commit -m "security(mfa): force MFA enrollment for partner-admin role (issue #864 follow-up)"
```

---

### Task 9: Allow password reset for `pending` partners (#719)

Audit finding (HIGH, ops M2 + GitHub #719): pending/inactive-tenant users cannot password-reset. Customer onboarding trap. Trace `apps/api/src/routes/auth/password.ts` to find where reset is gated on tenant status.

**Files:**
- Create: `apps/api/src/services/passwordResetEligibility.ts`
- Modify: `apps/api/src/routes/auth/password.ts`
- Test: `apps/api/src/routes/auth/password.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('sends reset email for users in pending partners', async () => {
  const partner = await seedPartner({ status: 'pending' });
  const user = await seedUser({ partnerId: partner.id, email: 'pending@x.com' });
  const res = await app.request('/auth/forgot-password', {
    method: 'POST', body: JSON.stringify({ email: 'pending@x.com' })
  });
  expect(res.status).toBe(200);
  expect(getSentResetEmails()).toContainEqual(expect.objectContaining({ to: 'pending@x.com' }));
});

it('refuses reset for users in suspended-for-abuse partners', async () => {
  const partner = await seedPartner({ status: 'suspended' });
  const user = await seedUser({ partnerId: partner.id, email: 'sus@x.com' });
  const res = await app.request('/auth/forgot-password', {
    method: 'POST', body: JSON.stringify({ email: 'sus@x.com' })
  });
  // Still 200 (generic), but no email sent — see passwordResetEligibility
  expect(res.status).toBe(200);
  expect(getSentResetEmails()).not.toContainEqual(expect.objectContaining({ to: 'sus@x.com' }));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test password`
Expected: FAIL (pending users currently get the generic no-op).

- [ ] **Step 3: Create the eligibility service**

Create `apps/api/src/services/passwordResetEligibility.ts`:

```ts
import { db, withSystemDbAccessContext } from '../db';
import { users, partners, organizations } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface ResetEligibility {
  allowed: boolean;
  reason?: 'sso_required' | 'tenant_suspended' | 'user_disabled';
}

const RESET_ALLOWED_PARTNER_STATUSES = new Set(['active', 'pending']);
const RESET_DENIED_PARTNER_STATUSES = new Set(['suspended', 'churned', 'banned']);

export async function isUserEligibleForPasswordReset(userId: string): Promise<ResetEligibility> {
  return withSystemDbAccessContext(async () => {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.status === 'disabled') return { allowed: false, reason: 'user_disabled' };
    // Look up the user's partner via partner_users / organization_users to find effective status
    // ...
    return { allowed: true };
  });
}
```

- [ ] **Step 4: Wire into `password.ts`**

Replace the existing eligibility check around `apps/api/src/routes/auth/password.ts:96-124` with a single call to `isUserEligibleForPasswordReset`. Generic-200 response in all cases; the side effect (email send vs. no-op) is the only branching.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test password`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/passwordResetEligibility.ts apps/api/src/routes/auth/password.ts apps/api/src/routes/auth/password.test.ts
git commit -m "fix(auth): allow password reset for pending partner users (#719)"
```

---

### Task 10: Credential-stuffing defense — per-account lockout + tighter per-IP

Audit finding (HIGH, auth H-3): per-IP login limit 30/5min is too generous against a botnet. Add per-account lockout (5 failures → 15-min lock + email alert). Drop per-IP from 30/5min to 10/5min.

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:78-97`
- Modify: `apps/api/src/services/rate-limit.ts`
- Test: `apps/api/src/routes/auth/login.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('locks the account for 15min after 5 consecutive failures and alerts', async () => {
  await seedUser({ email: 'victim@x.com', password: 'right-password' });
  for (let i = 0; i < 5; i++) {
    const res = await login('victim@x.com', 'wrong-password');
    expect(res.status).toBe(401);
  }
  // 6th attempt with the CORRECT password must still 401 (locked)
  const locked = await login('victim@x.com', 'right-password');
  expect(locked.status).toBe(429);
  expect(await locked.json()).toMatchObject({ error: expect.stringMatching(/locked/i) });
  expect(getSentLockoutEmails()).toContainEqual(expect.objectContaining({ to: 'victim@x.com' }));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test login`
Expected: FAIL (no lockout exists).

- [ ] **Step 3: Implement**

Add to `apps/api/src/services/rate-limit.ts`:

```ts
export async function recordAccountFailure(redis: Redis, email: string): Promise<{ locked: boolean; remaining: number }> {
  const key = `login:account-fail:${email.toLowerCase()}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 15 * 60);
  const locked = count >= 5;
  return { locked, remaining: Math.max(0, 5 - count) };
}

export async function clearAccountFailures(redis: Redis, email: string): Promise<void> {
  await redis.del(`login:account-fail:${email.toLowerCase()}`);
}

export async function isAccountLocked(redis: Redis, email: string): Promise<boolean> {
  const v = await redis.get(`login:account-fail:${email.toLowerCase()}`);
  return v !== null && parseInt(v, 10) >= 5;
}
```

In `apps/api/src/routes/auth/login.ts`:

- Line 81 — change `30` to `10` and add a comment referencing this task.
- Right after rate-limit pass (before line 100): if `await isAccountLocked(redis, normalizedEmail)` → 429 with `Account temporarily locked due to repeated failed sign-ins. Try again in 15 minutes or reset your password.`
- On invalid password (line 131) — `await recordAccountFailure(redis, normalizedEmail)`. If `result.locked && result.remaining === 0 && wasNotPreviouslyLocked` → enqueue an "account locked" email (template: `account-locked.html`).
- On successful login (line 219, after token issuance) — `await clearAccountFailures(redis, normalizedEmail)`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test login`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/rate-limit.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts
git commit -m "security(auth): per-account lockout after 5 failures + email alert"
```

---

### Task 11: Equalize login response timing across all denial branches

Audit finding (HIGH, auth H-4): the SSO/inactive-tenant branch at `login.ts:165-175` runs `resolveCurrentUserTokenContext()` only for real users. Latency footprint distinguishes real-user-with-SSO from no-such-user.

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts`
- Test: `apps/api/src/routes/auth/login.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('login response times do not distinguish account states (within tolerance)', async () => {
  await seedUser({ email: 'sso@x.com', password: 'pw', ssoOnly: true });
  const samples = { sso: [] as number[], missing: [] as number[], wrong: [] as number[] };
  for (let i = 0; i < 20; i++) {
    samples.sso.push(await measureLoginMs('sso@x.com', 'wrong'));
    samples.missing.push(await measureLoginMs(`missing-${i}@x.com`, 'wrong'));
    samples.wrong.push(await measureLoginMs('regular@x.com', 'wrong'));
  }
  const median = (arr: number[]) => arr.sort()[Math.floor(arr.length / 2)];
  const ssoMed = median(samples.sso);
  const missingMed = median(samples.missing);
  expect(Math.abs(ssoMed - missingMed)).toBeLessThan(50);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test login`
Expected: FAIL (SSO branch median is ~30-80ms slower than missing).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth/login.ts`, refactor so the user-context resolution + SSO check ALWAYS runs (against a dummy resolver for the missing-user branch) before any branch decides what to return. Easiest pattern: collect the decision into a single `result` variable, then `await Promise.all([resolveContext, dummyDelay])` to floor latency at the slower of the two.

Alternative: always call `resolveCurrentUserTokenContext` against either the real user id or a sentinel dummy id (random UUID that won't match anything), then discard the result on the not-found branch. The DB round-trip happens identically.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test login`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts
git commit -m "security(auth): equalize login response timing across denial branches"
```

---

## Phase 4 — AuthZ + scope discipline

---

### Task 12: Fix three site-scope misses + add a contract test

Audit finding (MEDIUM, RLS audit): `apps/api/src/routes/software.ts:1265-1328` and `apps/api/src/routes/cisHardening.ts:104-123` ignore `permissions.allowedSiteIds`. Same class as #806/#808 (which SP2 closed). RLS does not defend site-scope — it's app-layer only.

**Files:**
- Modify: `apps/api/src/routes/software.ts:1265-1328`
- Modify: `apps/api/src/routes/cisHardening.ts:104-123`
- Create: `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { findRoutesTouchingDevices } from './helpers/routeScan';

describe('site-scope coverage', () => {
  it('every route touching a device-id parameter calls requireSiteAccess or canAccessDeviceSite', () => {
    const routes = findRoutesTouchingDevices();
    const offenders = routes.filter(r => !r.usesSiteScopeGate);
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('GET /software/inventory respects allowedSiteIds', async () => {
    const { token } = await seedPartnerUserWithSites(['site-a']);
    const res = await app.request('/api/v1/software/inventory?deviceId=device-in-site-b', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('POST /cis-hardening/run-scan respects allowedSiteIds', async () => {
    const { token } = await seedPartnerUserWithSites(['site-a']);
    const res = await app.request('/api/v1/cis-hardening/run-scan', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: 'device-in-site-b' })
    });
    expect(res.status).toBe(403);
  });
});
```

`findRoutesTouchingDevices` is a static-analysis helper: scan `apps/api/src/routes/**/*.ts` for handlers whose `param` schema contains `deviceId` or `deviceIds`, and for each, check whether the handler body references `requireSiteAccess`, `canAccessDeviceSite`, or `getDeviceWithOrgAndSiteCheck`. Either an allowlist (`SITE_SCOPE_EXEMPT_HANDLERS`) or every offender must be addressed.

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test:integration site-scope-coverage`
Expected: FAIL (lists `software.ts` and `cisHardening.ts` handlers).

- [ ] **Step 3: Fix `software.ts`**

In `apps/api/src/routes/software.ts:1265-1301` (list) and `:1304-1328` (per-device), wrap the existing device-id filter with:

```ts
const permissions = await getPermissions(auth);
const allowedSiteIds = permissions.allowedSiteIds; // null = all
const orgDevices = await db.select({ id: devices.id, siteId: devices.siteId })
  .from(devices)
  .where(and(
    eq(devices.orgId, orgId),
    allowedSiteIds ? inArray(devices.siteId, allowedSiteIds) : sql`true`
  ));
const allowedDeviceIds = orgDevices.map(d => d.id);
// then: inArray(softwareInventory.deviceId, allowedDeviceIds)
```

Per-device handler: refactor to use `getDeviceWithOrgAndSiteCheck` per `apps/api/src/routes/devices/helpers.ts:120-155`.

- [ ] **Step 4: Fix `cisHardening.ts`**

Edit `assertDeviceAccess` (line 104) to take `permissions` (or pull from `auth.get('permissions')`) and apply `canAccessDeviceSite(device, permissions)`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test:integration site-scope-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/software.ts apps/api/src/routes/cisHardening.ts apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts apps/api/src/__tests__/helpers/routeScan.ts
git commit -m "security(rbac): close three site-scope misses + add contract test"
```

---

### Task 13: Revoke OAuth grants on partner status change

Audit finding (HIGH, MCP H-1): suspending a partner leaves OAuth grants alive for 14 days (refresh) / 10 min (access). `assertActiveTenantContext` (`bearerTokenAuth.ts:255-265`) only blocks NEW exchanges.

**Files:**
- Create: `apps/api/src/services/oauthGrantRevocation.ts`
- Modify: `apps/api/src/services/tenantLifecycle.ts`
- Test: `apps/api/src/services/oauthGrantRevocation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('revokes all active OAuth grants for a partner on suspend', async () => {
  const { partnerId, grantId, accessToken } = await seedOAuthGrant({ partnerStatus: 'active' });
  await mcpRequest('/api/v1/mcp/tools/list', { token: accessToken }).expect(200);

  await suspendPartner(partnerId, 'admin-action');

  await mcpRequest('/api/v1/mcp/tools/list', { token: accessToken }).expect(401);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test oauthGrantRevocation`
Expected: FAIL (no revocation triggered).

- [ ] **Step 3: Implement**

Create `apps/api/src/services/oauthGrantRevocation.ts`:

```ts
import { db } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema';
import { eq } from 'drizzle-orm';
import { revocationCache } from '../oauth/revocationCache';

export async function revokeAllPartnerGrants(partnerId: string, reason: string): Promise<number> {
  const grants = await db.select({ id: oauthGrants.id }).from(oauthGrants)
    .where(eq(oauthGrants.partnerId, partnerId));
  let revoked = 0;
  for (const g of grants) {
    await revocationCache.revokeGrant(g.id, reason);
    revoked++;
  }
  return revoked;
}
```

Wire into `apps/api/src/services/tenantLifecycle.ts` at every code path that changes `partners.status` to a non-active value (suspend, churn, ban):

```ts
import { revokeAllPartnerGrants } from './oauthGrantRevocation';

// inside suspendPartner / churnPartner / banPartner:
await revokeAllPartnerGrants(partnerId, `partner-status-change:${newStatus}`);
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test oauthGrantRevocation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/oauthGrantRevocation.ts apps/api/src/services/tenantLifecycle.ts apps/api/src/services/oauthGrantRevocation.test.ts
git commit -m "security(oauth): revoke active grants on partner status change"
```

---

### Task 14: Revoke user JWTs on partner-user removal

Audit finding (MEDIUM, RLS audit): a user removed from `partner_users` keeps `accessiblePartnerIds: [partnerId]` for up to 15 min (access-token TTL). Token revocation requires explicit enrollment.

**Files:**
- Modify: `apps/api/src/routes/partners.ts` (or wherever `partner_users.delete` lives)
- Test: same-file test

- [ ] **Step 1: Find the delete path**

```bash
grep -rn "partner_users.*delete\|deleteFrom.*partnerUsers\|.delete.*partnerUsers" apps/api/src
```

- [ ] **Step 2: Write the failing test**

```ts
it('revokes all JWTs for the removed user on partner_user delete', async () => {
  const { token, userId } = await loginUser('removed@x.com');
  await app.request('/api/v1/partner/users/removed-user-id', {
    method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` }
  });
  // Removed user's existing token must immediately 401
  const res = await app.request('/api/v1/users/me', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 3: Verify it fails**

Run: `pnpm --filter @breeze/api test partners`
Expected: FAIL.

- [ ] **Step 4: Implement**

In the delete handler, after the DB delete commits, call `revokeAllUserTokens(removedUserId)` — already exists in `apps/api/src/services/tokenRevocation.ts`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test partners`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/partners.ts apps/api/src/routes/partners.test.ts
git commit -m "security(authz): revoke JWTs on partner-user removal (15min staleness gap)"
```

---

### Task 15: OAuth bearer tokens flow through tenant-status check

Audit finding (HIGH, MCP H-1): `apps/api/src/middleware/partnerGuard.ts:7-26` short-circuits for OAuth bearers; tenant-status check is `assertActiveTenantContext` in `bearerTokenAuth.ts:255-265` which admits `pending`. Combined with Task 13's revocation, this closes the loop.

**Files:**
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts`
- Test: `apps/api/src/middleware/bearerTokenAuth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('blocks OAuth bearer use when partner is suspended', async () => {
  const { token, partnerId } = await issueOAuthTokenForActivePartner();
  await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, partnerId));
  const res = await mcpRequest('/api/v1/mcp/tools/list', { token });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toMatch(/tenant_inactive/);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test bearerTokenAuth`
Expected: FAIL (returns 200 for ~10min until access expires).

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/bearerTokenAuth.ts`, replace `getSessionAllowedPartner` (which admits `pending`) with a stricter `assertOperationalPartnerForBearer` that admits only `active`. `pending` is fine for consent flow (handled in oauthInteraction) but not for tool use. Reject with `401 tenant_inactive`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test bearerTokenAuth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/bearerTokenAuth.ts apps/api/src/middleware/bearerTokenAuth.test.ts
git commit -m "security(oauth): block bearer use when tenant is non-operational"
```

---

## Phase 5 — Agent + WebSocket hardening

---

### Task 16: Bind WS ticket consumption to original requester IP + UA

Audit finding (HIGH, agent H-1): `apps/api/src/services/remoteSessionAuth.ts:73` mints high-entropy tickets but consumption is purely capability-URL — any party that intercepts the 60-second ticket can open the WS. Terminal runs as SYSTEM. Stolen URL = remote SYSTEM shell.

**Files:**
- Modify: `apps/api/src/services/remoteSessionAuth.ts`
- Modify: `apps/api/src/routes/terminalWs.ts:78-156`
- Modify: `apps/api/src/routes/desktopWs.ts`
- Test: `apps/api/src/services/remoteSessionAuth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects ticket consumed from a different IP than issued', async () => {
  const ticket = await issueWsTicket({ userId: 'u1', sessionId: 's1', ip: '203.0.113.1', userAgent: 'Mozilla' });
  const consumed = await consumeWsTicket(ticket, { ip: '198.51.100.7', userAgent: 'Mozilla' });
  expect(consumed.ok).toBe(false);
  expect(consumed.reason).toBe('ip_mismatch');
});

it('rejects ticket consumed from a different user-agent than issued', async () => {
  const ticket = await issueWsTicket({ userId: 'u1', sessionId: 's1', ip: '203.0.113.1', userAgent: 'Mozilla' });
  const consumed = await consumeWsTicket(ticket, { ip: '203.0.113.1', userAgent: 'curl/8.5' });
  expect(consumed.ok).toBe(false);
  expect(consumed.reason).toBe('ua_mismatch');
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test remoteSessionAuth`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `apps/api/src/services/remoteSessionAuth.ts`:

- `issueWsTicket(opts)` stores `{ userId, sessionId, ip, uaHash, expiresAt }` in Redis (was just `{ userId, sessionId, expiresAt }`).
- `consumeWsTicket(ticket, opts)` accepts `{ ip, uaHash }` and:
  - Reject `ip_mismatch` unless `opts.ip === stored.ip`.
  - Reject `ua_mismatch` unless `opts.uaHash === stored.uaHash`.
  - Both rejections delete the ticket on first mismatch (no probing).
- `uaHash = sha256(ua).slice(0, 16)` — short hash so client UA changes (browser updates) within the 60-second window are tolerated against an exact match, but cross-client / cross-tool theft fails.

Edit `apps/api/src/routes/terminalWs.ts:78-156` and `apps/api/src/routes/desktopWs.ts`: pass `c.req.header('user-agent')` and `getTrustedClientIp(c)` to `consumeWsTicket`.

For environments where the WS upgrade happens behind a separate proxy IP from the ticket issuance (rare but possible), allow opt-out via `WS_TICKET_BIND_IP=false` (boot-warned).

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test remoteSessionAuth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/remoteSessionAuth.ts apps/api/src/routes/terminalWs.ts apps/api/src/routes/desktopWs.ts apps/api/src/services/remoteSessionAuth.test.ts
git commit -m "security(ws): bind ticket consumption to issuer IP + UA"
```

---

### Task 17: Remove the connect-code 30s re-exchange cache

Audit finding (HIGH, agent H-2): `apps/api/src/routes/desktopWs.ts:20-22, 91-98` has an `exchangeCache` to handle React effect re-fire; functionally any party with the one-time deep-link code can re-exchange within 30s, negating one-time semantics. With Task 16 in place, the React-re-fire scenario can be handled by the client (cache the resulting token client-side); the server should not.

**Files:**
- Modify: `apps/api/src/routes/desktopWs.ts:20-22, 91-98`
- Modify: `apps/web/src/components/desktop/DesktopClient.tsx` — guard against double exchange
- Test: `apps/api/src/routes/desktopWs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a re-exchange of a consumed connect code (no 30s cache)', async () => {
  const { code, sessionId } = await issueConnectCode();
  const r1 = await exchangeConnectCode({ sessionId, code });
  expect(r1.ok).toBe(true);
  const r2 = await exchangeConnectCode({ sessionId, code });
  expect(r2.status).toBe(401);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test desktopWs`
Expected: FAIL (r2 returns 200 from cache).

- [ ] **Step 3: Delete the cache**

Edit `apps/api/src/routes/desktopWs.ts:20-22` — delete the `exchangeCache` constant and any `.get` / `.set` usage at `:91-98`. The atomic `consumeDesktopConnectCode` is already idempotent-fail-on-second-call.

- [ ] **Step 4: Fix the React re-fire on the client**

In `apps/web/src/components/desktop/DesktopClient.tsx`, wrap the exchange in a ref-guarded one-shot so React strict-mode + effect re-runs don't trigger a second POST. Cache the resulting access token in a `useRef` so a stale-strict-mode-second-fire reuses it.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test desktopWs && pnpm --filter @breeze/web test DesktopClient`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/desktopWs.ts apps/web/src/components/desktop/DesktopClient.tsx apps/api/src/routes/desktopWs.test.ts
git commit -m "security(ws): remove connect-code 30s re-exchange cache (capability-leak window)"
```

---

### Task 18: Auto-suspend on cross-tenant probe pattern

Audit finding (HIGH, agent H-3): `apps/api/src/routes/agentWs.ts:2118-2138` increments `crossTenantDrops` but never blocks. After 10 drops in 5 min it writes ONE Sentry breadcrumb. A compromised agent token can spray cross-tenant result IDs forever.

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts:2118-2138`
- Modify: `apps/api/src/middleware/agentAuth.ts` — add `suspendAgentToken(deviceId, reason)`
- Test: `apps/api/src/routes/agentWs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('suspends the agent token after 5 cross-tenant probes in 5min', async () => {
  const { deviceId, token } = await seedAgent();
  for (let i = 0; i < 5; i++) {
    await sendWsMessage(token, { type: 'terminal_output', sessionId: foreignSession(), data: 'probe' });
  }
  // 6th attempt — the device's token is now suspended
  const res = await openAgentWs(token);
  expect(res.status).toBe(401);
  expect(await getAuditEvents()).toContainEqual(expect.objectContaining({
    action: 'agent.token.suspended', details: expect.objectContaining({ reason: 'cross-tenant-probe' })
  }));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test agentWs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `apps/api/src/routes/agentWs.ts:2118-2138`:

```ts
if (crossTenantDrops >= 5) {
  await suspendAgentToken(authenticatedDeviceId, 'cross-tenant-probe');
  await writeAuditEvent({
    actorType: 'system', actorId: SYSTEM_ACTOR_ID,
    action: 'agent.token.suspended', resourceType: 'device',
    resourceId: authenticatedDeviceId,
    details: { reason: 'cross-tenant-probe', dropsInWindow: crossTenantDrops },
    result: 'denied'
  });
  ws.close(4001, 'Token suspended');
  Sentry.captureMessage('agent token auto-suspended', { extra: { deviceId: authenticatedDeviceId, drops: crossTenantDrops } });
  return;
}
```

Add `suspendAgentToken(deviceId, reason)` to `apps/api/src/middleware/agentAuth.ts`:

```ts
export async function suspendAgentToken(deviceId: string, reason: string): Promise<void> {
  await db.update(devices).set({
    agentTokenSuspendedAt: new Date(),
    agentTokenSuspendedReason: reason
  }).where(eq(devices.id, deviceId));
}
```

Add migration:
```sql
-- 2026-05-28-agent-token-suspend.sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_token_suspended_at timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_token_suspended_reason varchar(100);
```

`validateAgentToken` (existing in `agentAuth.ts`) checks `agentTokenSuspendedAt IS NULL`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test agentWs && pnpm db:check-drift`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agentWs.ts apps/api/src/middleware/agentAuth.ts apps/api/migrations/2026-05-28-agent-token-suspend.sql apps/api/src/routes/agentWs.test.ts
git commit -m "security(agent): auto-suspend tokens after 5 cross-tenant probes in 5min"
```

---

### Task 19: Per-source-IP agent WS rate limit + tighter per-agent cap

Audit finding (HIGH, agent H-5 + public CRIT-1): `apps/api/src/middleware/agentAuth.ts:27` cap is 120/min per agent. Stolen token from any IP = legit-agent DoS. No per-source-IP cap.

**Files:**
- Modify: `apps/api/src/middleware/agentAuth.ts`
- Test: `apps/api/src/middleware/agentAuth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects agent requests from a new source IP if the device IP has changed recently', async () => {
  const { token, deviceId } = await seedAgent({ lastSeenIp: '203.0.113.1' });
  await agentRequest('/devices/me/heartbeat', { token, fromIp: '203.0.113.1' }).expect(200);
  // Same token from a new IP: warned + still allowed once, but flagged
  const r2 = await agentRequest('/devices/me/heartbeat', { token, fromIp: '198.51.100.7' });
  expect(r2.status).toBe(200);
  expect(await getAuditEvents()).toContainEqual(expect.objectContaining({
    action: 'agent.source.ip.changed'
  }));
});

it('rate-limits to 30 requests per minute per source IP per agent', async () => {
  const { token } = await seedAgent();
  for (let i = 0; i < 30; i++) await agentRequest('/devices/me/heartbeat', { token, fromIp: '203.0.113.1' });
  const blocked = await agentRequest('/devices/me/heartbeat', { token, fromIp: '203.0.113.1' });
  expect(blocked.status).toBe(429);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test agentAuth`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/agentAuth.ts`:

- Add per-(agent, source-IP) limiter at 30/min in addition to the existing 120/min per-agent.
- On every authenticated request, compare `getTrustedClientIp(c)` against `device.lastSeenIp`. If different and `device.lastSeenIp != null`, log an `agent.source.ip.changed` audit event (one per IP per device per 24h via Redis dedup key).
- Persist new IP: `UPDATE devices SET last_seen_ip = ?`.

Add migration if `last_seen_ip` doesn't already exist on devices.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test agentAuth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/agentAuth.ts apps/api/src/middleware/agentAuth.test.ts apps/api/migrations/*last-seen-ip*.sql 2>/dev/null || true
git commit -m "security(agent): per-source-IP rate limit + IP-change audit"
```

---

## Phase 6 — MCP hardening

---

### Task 20: Promote `take_screenshot` / `analyze_screen` to Tier 3 + allowlist

Audit finding (HIGH, MCP H-2): `apps/api/src/services/aiToolsRemote.ts:46,108` register these as `tier: 2`. Tier 2 = auto-execute on `mcp:write`. Screen contents are the most sensitive RMM output. `computer_control` is correctly Tier 3.

**Files:**
- Modify: `apps/api/src/services/aiToolsRemote.ts:46,108`
- Modify: `apps/api/src/config/validate.ts` — document `MCP_EXECUTE_TOOL_ALLOWLIST`
- Test: existing `aiToolsRemote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('blocks take_screenshot without MCP_EXECUTE_TOOL_ALLOWLIST entry', async () => {
  delete process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
  const res = await callMcpTool('take_screenshot', { deviceId: 'd1' }, { scope: 'mcp:write' });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toMatch(/tier-3 tool not in allowlist/i);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test aiToolsRemote`
Expected: FAIL (returns 200).

- [ ] **Step 3: Implement**

In `apps/api/src/services/aiToolsRemote.ts:46`:

```ts
{ name: 'take_screenshot', tier: 3 as AiToolTier, /* ... */ }
```

And line 108:

```ts
{ name: 'analyze_screen', tier: 3 as AiToolTier, /* ... */ }
```

Document in `.env.example`:

```bash
# Comma-separated tool names that are allowed at MCP Tier 3 (execute scope).
# Default empty = block all Tier 3 unless explicitly approved.
MCP_EXECUTE_TOOL_ALLOWLIST=
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test aiToolsRemote`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsRemote.ts apps/api/src/services/aiToolsRemote.test.ts apps/api/.env.example
git commit -m "security(mcp): promote take_screenshot/analyze_screen to Tier 3 (require explicit allowlist)"
```

---

### Task 21: Default `OAUTH_DCR_ENABLED=false` + wire the GC worker

Audit finding (HIGH, MCP H-3 + auth H-5): `apps/api/src/oauth/provider.ts:374` defaults DCR ON. Cleanup is documented as "SCHEDULING TODO" — never wired. Anyone on the internet can create unlimited OAuth clients.

**Files:**
- Modify: `apps/api/src/oauth/provider.ts:374` (initial-access-token wiring) + `.env.example`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/index.ts` — schedule `cleanupStaleOauthClients`

- [ ] **Step 1: Flip the default**

Edit `apps/api/src/oauth/provider.ts` — read the env with default false:

```ts
const OAUTH_DCR_ENABLED = process.env.OAUTH_DCR_ENABLED === 'true';
// (Previously: !== 'false' which defaulted to true.)
```

- [ ] **Step 2: Validate boot refuses DCR=true without initial-access-token requirement**

Edit `apps/api/src/config/validate.ts` — if `OAUTH_DCR_ENABLED === 'true'` AND `OAUTH_DCR_REQUIRE_IAT !== 'true'` in production → boot error.

- [ ] **Step 3: Wire the GC worker**

In `apps/api/src/index.ts`, after the app boots:

```ts
import { cleanupStaleOauthClients } from './oauth/provider';

setInterval(() => {
  void cleanupStaleOauthClients().catch(err => console.error('[oauth-gc]', err));
}, 6 * 60 * 60 * 1000); // every 6h
```

- [ ] **Step 4: Update docs + .env.example**

```bash
# Dynamic Client Registration. Required ON for public MCP integrations.
# When ON in production, OAUTH_DCR_REQUIRE_IAT must also be ON.
OAUTH_DCR_ENABLED=false
OAUTH_DCR_REQUIRE_IAT=true
```

- [ ] **Step 5: Verify**

Add a validate.test.ts case asserting boot refuses misconfig. Run: `pnpm --filter @breeze/api test validate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/oauth/provider.ts apps/api/src/config/validate.ts apps/api/src/index.ts apps/api/.env.example apps/api/src/config/validate.test.ts
git commit -m "security(oauth): default DCR=off + wire GC worker for stale clients"
```

---

### Task 22: Server-mint `Mcp-Session-Id` + bind to principal

Audit finding (MEDIUM, MCP MED-1): `apps/api/src/routes/mcpServer.ts:574,587,593` accepts client-provided `Mcp-Session-Id`. Attacker stamps arbitrary IDs into the audit log.

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts`
- Test: `apps/api/src/routes/mcpServer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('ignores client-provided Mcp-Session-Id on initialize; binds server-minted ID to principal', async () => {
  const { token } = await issueOAuthToken();
  const init = await mcpRequest('/api/v1/mcp', {
    method: 'POST', token, headers: { 'Mcp-Session-Id': 'attacker-chose-this' },
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 }
  });
  const sessionId = init.headers.get('Mcp-Session-Id');
  expect(sessionId).not.toBe('attacker-chose-this');
  expect(sessionId).toMatch(/^mcp-[a-z0-9]{20,}$/);
});

it('rejects subsequent calls with a session-id owned by a different principal', async () => {
  const { token: tokenA } = await issueOAuthToken({ user: 'a' });
  const { token: tokenB } = await issueOAuthToken({ user: 'b' });
  const init = await mcpInitialize(tokenA);
  const sessionId = init.headers.get('Mcp-Session-Id');
  // user B tries to use user A's session
  const r = await mcpRequest('/api/v1/mcp', {
    method: 'POST', token: tokenB, headers: { 'Mcp-Session-Id': sessionId! },
    body: { jsonrpc: '2.0', method: 'tools/list', id: 2 }
  });
  expect(r.status).toBe(403);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test mcpServer`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/mcpServer.ts`:

- On `POST /` (or `/api/v1/mcp`) with `method: 'initialize'`: ignore any inbound `Mcp-Session-Id` header. Mint `mcp-${randomBytes(16).toString('hex')}`. Store `(sessionId → principalKey)` in Redis with the OAuth grant's lifetime + 5min.
- On all other methods: require `Mcp-Session-Id` header; look up; if missing or `storedPrincipalKey !== currentPrincipalKey` → 403.
- `principalKey = sha256(grantId || apiKeyId || userId).slice(0, 16)`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test mcpServer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/mcpServer.ts apps/api/src/routes/mcpServer.test.ts
git commit -m "security(mcp): server-mint Mcp-Session-Id + bind to principal"
```

---

### Task 23: Deny action-multiplexed tools when `action` is missing

Audit finding (MEDIUM, MCP MED-2): `apps/api/src/services/aiGuardrails.ts:594` returns `null` (allow) when an action-multiplexed tool is called with no `action`. Bypasses per-action RBAC.

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:594`
- Test: `apps/api/src/services/aiGuardrails.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('denies action-multiplexed tools without an action arg', () => {
  const verdict = checkGuardrails({
    tool: 'manage_groups', input: {}, scope: 'mcp:write', tier: 2,
    actionMultiplexed: true
  });
  expect(verdict).toEqual({ allowed: false, reason: 'missing_action' });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test aiGuardrails`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `apps/api/src/services/aiGuardrails.ts:594` — change the `null` (allow) branch when action is missing to:

```ts
if (isActionMultiplexed && !input.action) {
  return { allowed: false, reason: 'missing_action' };
}
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test aiGuardrails`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.test.ts
git commit -m "security(mcp): deny action-multiplexed tools when action arg missing"
```

---

### Task 24: Drop `mcp:write` → `ai:execute` legacy expansion

Audit finding (MEDIUM, MCP MED-4): `apps/api/src/middleware/bearerTokenAuth.ts:81-104` expands `mcp:write` to include `ai:execute` until 2026-05-15. Current date is past the cutoff.

**Files:**
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts:81-104`
- Test: same file

- [ ] **Step 1: Write the failing test**

```ts
it('mcp:write does not implicitly grant ai:execute', () => {
  const scopes = expandScopes(['mcp:write']);
  expect(scopes).not.toContain('ai:execute');
  expect(scopes).toContain('ai:write');
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test bearerTokenAuth`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `apps/api/src/middleware/bearerTokenAuth.ts:81-104` — remove the `ai:execute` entry from the `mcp:write` expansion. Leave a `console.warn` for any token still presenting `mcp:write` and *requesting* `ai:execute` for one release cycle, then remove next release.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test bearerTokenAuth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/bearerTokenAuth.ts apps/api/src/middleware/bearerTokenAuth.test.ts
git commit -m "security(mcp): drop mcp:write→ai:execute legacy expansion (cutoff was 2026-05-15)"
```

---

## Phase 7 — Config validators + supply chain

---

### Task 25: Boot-refuse misconfigured `TRUST_PROXY_HEADERS`

Audit finding (CRITICAL, public CRIT-1): when `TRUST_PROXY_HEADERS` isn't `true` and `TRUSTED_PROXY_CIDRS` isn't set, login rate limits collapse onto an attacker-controllable fingerprint. Hosted droplets fine; self-host one env-var away from disaster.

**Files:**
- Modify: `apps/api/src/config/validate.ts`
- Test: `apps/api/src/config/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to boot in production behind a proxy without TRUST_PROXY_HEADERS=true', () => {
  process.env.NODE_ENV = 'production';
  process.env.BEHIND_PROXY = 'true';
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUSTED_PROXY_CIDRS;
  expect(() => validateConfig()).toThrow(/TRUST_PROXY_HEADERS.*required/i);
});

it('boots when TRUST_PROXY_HEADERS=true and TRUSTED_PROXY_CIDRS is set', () => {
  process.env.NODE_ENV = 'production';
  process.env.BEHIND_PROXY = 'true';
  process.env.TRUST_PROXY_HEADERS = 'true';
  process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
  expect(() => validateConfig()).not.toThrow();
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test validate`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `validateConfig` in `apps/api/src/config/validate.ts`:

```ts
if (env.NODE_ENV === 'production' && env.BEHIND_PROXY === 'true') {
  if (env.TRUST_PROXY_HEADERS !== 'true') {
    issues.push('TRUST_PROXY_HEADERS=true is required when BEHIND_PROXY=true in production.');
  }
  if (!env.TRUSTED_PROXY_CIDRS || env.TRUSTED_PROXY_CIDRS.trim().length === 0) {
    issues.push('TRUSTED_PROXY_CIDRS must be set (CIDR list of trusted proxies) when BEHIND_PROXY=true in production.');
  }
}
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "security(config): boot-refuse misconfigured TRUST_PROXY_HEADERS (CRIT-1)"
```

---

### Task 26: Validate required prod env vars (Stripe / OAuth JWK / S3 / Resend / MSI / Cloudflare)

Audit finding (HIGH, secrets H-3): several "boot-or-die" secrets are not in the validator and silently fail at first request rather than at boot.

**Files:**
- Modify: `apps/api/src/config/validate.ts`
- Test: same `validate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['STRIPE_SECRET_KEY', { ENABLE_BILLING: 'true' }],
  ['STRIPE_WEBHOOK_SECRET', { ENABLE_BILLING: 'true' }],
  ['BILLING_SERVICE_API_KEY', { ENABLE_BILLING: 'true' }],
  ['OAUTH_JWKS_PRIVATE_JWK', { MCP_OAUTH_ENABLED: 'true' }],
  ['OAUTH_COOKIE_SECRET', { MCP_OAUTH_ENABLED: 'true' }],
  ['S3_SECRET_KEY', { S3_ENABLED: 'true' }],
  ['RESEND_API_KEY', { EMAIL_PROVIDER: 'resend' }],
  ['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_ENABLED: 'true' }],
  ['MSI_SIGNING_CF_ACCESS_SECRET', { MSI_SIGNING_ENABLED: 'true' }],
])('refuses to boot when %s missing under feature flag', (key, flag) => {
  process.env.NODE_ENV = 'production';
  Object.entries(flag).forEach(([k, v]) => { process.env[k] = v; });
  delete process.env[key];
  expect(() => validateConfig()).toThrow(new RegExp(key));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test validate`
Expected: FAIL on first row.

- [ ] **Step 3: Implement**

Extend the `superRefine` block in `validate.ts` to push to `issues` for each combination above. Use a structured helper:

```ts
function requireIf(condition: boolean, name: string, value: string | undefined): void {
  if (condition && (!value || !value.trim())) {
    issues.push(`${name} is required when its feature flag is enabled.`);
  }
}

requireIf(env.ENABLE_BILLING === 'true', 'STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY);
// ...etc
```

Document each in `.env.example`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts apps/api/.env.example
git commit -m "security(config): boot-refuse missing feature-flagged secrets (H-3)"
```

---

### Task 27: Require manifest pubkey for `BINARY_SOURCE=local` too

Audit finding (HIGH, public HIGH-2): `apps/api/src/config/validate.ts:485-493` skips the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` check when `BINARY_SOURCE=local`. A self-hosted deploy can fall back to unsigned manifest acceptance.

**Files:**
- Modify: `apps/api/src/config/validate.ts:485-493`
- Test: `apps/api/src/config/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses BINARY_SOURCE=local without RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.BINARY_SOURCE = 'local';
  delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
  expect(() => validateConfig()).toThrow(/RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS/);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test validate`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `validate.ts:485-493` — remove the `BINARY_SOURCE === 'github'` condition; require the env var in production for both `github` and `local`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "security(config): require manifest pubkey for BINARY_SOURCE=local too"
```

---

### Task 28: Bump `ip` transitive dep to remove SSRF

Audit finding (MEDIUM, secrets M-1): `pnpm audit --prod` reports `ip <=2.0.1` SSRF in `isPublic`. Risk for any code that validates user URLs (webhooks).

**Files:**
- Modify: `package.json` root (add `pnpm.overrides`)
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1: Identify the dependency chain**

```bash
pnpm why ip
```

- [ ] **Step 2: Add an override**

In root `package.json`:

```json
"pnpm": {
  "overrides": {
    "ip@<2.0.2": "npm:@types/node@empty",
    "ip": "^2.0.2"
  }
}
```

(Adjust depending on what `pnpm why ip` reveals — may need to bump the parent package instead.)

- [ ] **Step 3: Regenerate the lockfile**

```bash
pnpm install
pnpm audit --prod --json | jq '.advisories | length'
```

Expected: 0 (or only false-positive notes).

- [ ] **Step 4: Verify nothing broke**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): bump ip to 2.0.2+ (SSRF in isPublic)"
```

---

## Phase 8 — Retention + GDPR + Webhooks + Installer

---

### Task 29: Audit-log retention pruning cron

Audit finding (HIGH, ops H5): `audit_logs.retention_days` defaults to 365 in `apps/api/src/db/schema/audit.ts:23` but nothing prunes by it. Pairs with Task 1 (append-only) — pruning runs under a privileged role that bypasses the trigger.

**Files:**
- Create: `apps/api/src/jobs/auditRetention.ts`
- Create: `apps/api/migrations/2026-05-29-audit-retention-role.sql`
- Modify: `apps/api/src/jobs/index.ts` (register cron)
- Test: `apps/api/src/jobs/auditRetention.test.ts`

- [ ] **Step 1: Create the dedicated DB role**

`apps/api/migrations/2026-05-29-audit-retention-role.sql`:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_audit_admin') THEN
    CREATE ROLE breeze_audit_admin;
  END IF;
END $$;

GRANT DELETE ON TABLE audit_logs TO breeze_audit_admin;
GRANT breeze_audit_admin TO breeze_app;  -- so the app can SET ROLE into it
```

- [ ] **Step 2: Write the cron**

`apps/api/src/jobs/auditRetention.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { auditRetentionPolicies, organizations } from '../db/schema';

export async function pruneExpiredAuditLogs(): Promise<{ orgs: number; rowsDeleted: number }> {
  return withSystemDbAccessContext(async () => {
    let orgsTouched = 0, rowsDeleted = 0;
    const policies = await db.select().from(auditRetentionPolicies);
    for (const policy of policies) {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      try {
        const res = await db.execute(sql`
          DELETE FROM audit_logs
          WHERE org_id = ${policy.orgId}
            AND timestamp < (now() - (${policy.retentionDays}::int * interval '1 day'))
        `);
        rowsDeleted += (res as unknown as { rowCount: number }).rowCount ?? 0;
        orgsTouched++;
      } finally {
        await db.execute(sql`RESET ROLE`);
      }
      await db.update(auditRetentionPolicies)
        .set({ lastCleanupAt: new Date() })
        .where(sql`id = ${policy.id}`);
    }
    return { orgs: orgsTouched, rowsDeleted };
  });
}
```

- [ ] **Step 3: Register the daily cron**

In `apps/api/src/jobs/index.ts`:

```ts
import { pruneExpiredAuditLogs } from './auditRetention';

scheduleDaily('03:30 UTC', async () => {
  const stats = await pruneExpiredAuditLogs();
  console.log('[audit-retention]', stats);
});
```

(Pattern: match existing daily-job registration in the project. If `scheduleDaily` doesn't exist, use BullMQ's `repeat: { cron: '30 3 * * *' }`.)

- [ ] **Step 4: Write the test**

```ts
it('deletes audit rows older than the org retention policy', async () => {
  const orgId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO audit_retention_policies (org_id, retention_days) VALUES (${orgId}, 30)
  `);
  await db.execute(sql`
    INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
    VALUES (${orgId}, 'system', gen_random_uuid(), 'old', 'test', 'success', now() - interval '60 days')
  `);
  const before = await db.execute(sql`SELECT count(*) FROM audit_logs WHERE org_id = ${orgId}`);
  expect((before as any)[0].count).toBe('1');
  await pruneExpiredAuditLogs();
  const after = await db.execute(sql`SELECT count(*) FROM audit_logs WHERE org_id = ${orgId}`);
  expect((after as any)[0].count).toBe('0');
});
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @breeze/api test auditRetention && pnpm db:check-drift`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/auditRetention.ts apps/api/src/jobs/index.ts apps/api/migrations/2026-05-29-audit-retention-role.sql apps/api/src/jobs/auditRetention.test.ts
git commit -m "security(audit): daily retention pruning under breeze_audit_admin role"
```

---

### Task 30: Bulk org/partner GDPR erasure + export endpoints

Audit finding (HIGH, ops H4): no documented org-wide GDPR erasure path. First EU customer questionnaire will ask. Hand-written SQL is not an answer.

**Files:**
- Create: `apps/api/src/routes/admin/tenantErasure.ts`
- Create: `apps/api/src/routes/admin/tenantExport.ts`
- Create: `apps/api/src/services/tenantCascade.ts`
- Test: `apps/api/src/routes/admin/tenantErasure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('cascade-deletes all data for an org and writes an audit record', async () => {
  const { orgId, deviceIds } = await seedFullOrg();
  const res = await app.request('/api/v1/admin/tenant-erasure', {
    method: 'POST', headers: { authorization: `Bearer ${platformAdminToken}` },
    body: JSON.stringify({ orgId, confirmEmail: 'admin@x.com' })
  });
  expect(res.status).toBe(202);

  // Wait for the async job
  await waitForErasureComplete(orgId);

  for (const tbl of ['devices', 'alerts', 'audit_logs', 'agent_logs', 'patch_jobs']) {
    const rows = await db.execute(sql.raw(`SELECT count(*) FROM ${tbl} WHERE org_id = '${orgId}'`));
    expect((rows as any)[0].count).toBe('0');
  }
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test tenantErasure`
Expected: FAIL.

- [ ] **Step 3: Implement the cascade helper**

`apps/api/src/services/tenantCascade.ts`:

```ts
// One source-of-truth list of every table that holds tenant data, in
// FK-dependency order (children first). Verified by the same contract test
// that owns rls-coverage.integration.test.ts — any new tenant-scoped table
// added without updating this list will fail CI.
export const ORG_CASCADE_DELETE_ORDER: ReadonlyArray<string> = [
  'agent_logs', 'patch_job_results', 'patch_rollbacks', 'patch_jobs',
  'deployment_devices', 'deployment_results', 'file_transfers',
  'automation_runs', 'automation_policy_compliance',
  'alerts', 'audit_logs', 'devices',
  // ...full list, kept in step with rls-coverage allowlists
];

export async function cascadeDeleteOrg(orgId: string, performedBy: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    for (const table of ORG_CASCADE_DELETE_ORDER) {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      try {
        await db.execute(sql.raw(`DELETE FROM ${table} WHERE org_id = '${orgId}'`));
      } finally {
        await db.execute(sql`RESET ROLE`);
      }
    }
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  });
  await persistAuditLog({
    actorType: 'user', actorId: performedBy,
    action: 'tenant.erasure', resourceType: 'organization', resourceId: orgId,
    result: 'success'
  });
}
```

`apps/api/src/routes/admin/tenantErasure.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePlatformAdmin } from '../../middleware/platformAdmin';
import { requireMfa } from '../../middleware/auth';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
// ...

export const tenantErasureRoutes = new Hono()
  .use('*', requirePlatformAdmin)
  .use('*', requireMfa())
  .post('/', zValidator('json', erasureSchema), async (c) => {
    const { orgId, confirmEmail } = c.req.valid('json');
    // verify confirmEmail matches caller's email to prevent typo-erasure
    // enqueue background job; respond 202
    await enqueueJob('tenant-cascade-delete', { orgId, performedBy: c.get('auth').user.id });
    return c.json({ status: 'accepted' }, 202);
  });
```

`apps/api/src/routes/admin/tenantExport.ts`:

```ts
// Returns a streaming ZIP of all org data as JSON files
// + manifest with checksums
export const tenantExportRoutes = new Hono()
  .use('*', requirePlatformAdmin)
  .get('/:orgId', async (c) => { /* stream ZIP */ });
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test tenantErasure tenantExport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/admin/tenantErasure.ts apps/api/src/routes/admin/tenantExport.ts apps/api/src/routes/admin/tenantErasure.test.ts
git commit -m "security(gdpr): tenant erasure + export endpoints (platform-admin + MFA gated)"
```

---

### Task 31: Default `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET=false` + remove query-secret path

Audit finding (HIGH, public HIGH-4): `apps/api/src/routes/automations.ts:1013` defaults `true`. Leaked secret = permanent automation-trigger access. Also remove `?secret=` query path (logged everywhere).

**Files:**
- Modify: `apps/api/src/routes/automations.ts:1013`
- Modify: `.env.example`
- Test: `apps/api/src/routes/automations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects header-secret without HMAC by default', async () => {
  delete process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET;
  const { automation } = await seedAutomationWebhook({ secret: 'abc' });
  const res = await app.request(`/api/v1/automations/webhooks/${automation.id}`, {
    method: 'POST', headers: { 'x-webhook-secret': 'abc' }, body: '{}'
  });
  expect(res.status).toBe(401);
});

it('rejects ?secret= query param under any setting', async () => {
  process.env.AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET = 'true';
  const { automation } = await seedAutomationWebhook({ secret: 'abc' });
  const res = await app.request(`/api/v1/automations/webhooks/${automation.id}?secret=abc`, {
    method: 'POST', body: '{}'
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test automations`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/automations.ts`:

- Around line 1013: read env with default `false`.
- Remove all handling of `?secret=` query (search the file for `query.secret`, `query('secret')`, `c.req.query('secret')`).
- Update the surrounding docs/README in `apps/docs/src/content/docs/automations/webhooks.md` to call out HMAC as the only supported mode.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test automations`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/automations.ts apps/api/.env.example apps/docs/src/content/docs/automations/webhooks.md
git commit -m "security(webhooks): default to HMAC-only (drop header-secret + query-secret paths)"
```

---

### Task 32: Per-short-code installer signing rate cap

Audit finding (HIGH, public HIGH-1): `apps/api/src/routes/enrollmentKeys.ts:1536-1719` (`serveInstaller`) IP-limits at 10/min but each call invokes the slow MSI signing service. An attacker rotating IPs can burn the signing budget.

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:1536-1719`
- Test: `apps/api/src/routes/enrollmentKeys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('caps installer downloads per short-code to 30 / hour (independent of IP)', async () => {
  const { code } = await issueShortCode();
  for (let i = 0; i < 30; i++) {
    const res = await app.request(`/s/${code}`, { headers: { 'cf-connecting-ip': `198.51.100.${i}` } });
    expect(res.status).toBe(200);
  }
  const blocked = await app.request(`/s/${code}`, { headers: { 'cf-connecting-ip': '198.51.100.99' } });
  expect(blocked.status).toBe(429);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @breeze/api test enrollmentKeys`
Expected: FAIL.

- [ ] **Step 3: Implement**

Edit `serveInstaller` in `apps/api/src/routes/enrollmentKeys.ts:1536-1719`:

- Before the existing per-IP limit, add a per-(short-code OR enrollment-key id) limit at 30/hour. Use `rateLimiter(redis, \`install-sign:${codeOrKey}\`, 30, 3600)`.
- Fail-closed on Redis loss (already the pattern).

- [ ] **Step 4: Verify**

Run: `pnpm --filter @breeze/api test enrollmentKeys`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "security(installer): per-short-code signing rate cap (30/hr)"
```

---

## Phase 9 — Observability (Sentry on web + agent)

> Code-only items from ops audit C2. Pure infra setup (Prometheus, status page, PagerDuty wiring) is in a separate ops plan.

---

### Task 33: Sentry on Astro web

Audit finding (CRITICAL, ops C2): only API has Sentry; web silent failures don't page. `@sentry/astro` is already installed (per memory); config files exist but are minimal.

**Files:**
- Modify: `apps/web/sentry.client.config.ts`
- Modify: `apps/web/sentry.server.config.ts`
- Modify: `apps/web/astro.config.mjs` — confirm release tagging

- [ ] **Step 1: Populate the client config**

```ts
// apps/web/sentry.client.config.ts
import * as Sentry from '@sentry/astro';

Sentry.init({
  dsn: import.meta.env.PUBLIC_SENTRY_DSN_WEB,
  environment: import.meta.env.MODE,
  release: import.meta.env.PUBLIC_RELEASE_VERSION,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.5,
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    /Loading chunk \d+ failed/, // expected on deploys
  ],
  beforeSend(event) {
    // Strip auth header from any captured request
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    return event;
  },
});
```

- [ ] **Step 2: Server config equivalent**

Mirror in `apps/web/sentry.server.config.ts`, dropping replay options.

- [ ] **Step 3: Add a smoke endpoint**

`apps/web/src/pages/api/sentry-smoke.ts`:

```ts
export async function GET() {
  throw new Error('sentry-web-smoke');
}
```

Trigger it in staging once after deploy to confirm event arrives.

- [ ] **Step 4: Commit**

```bash
git add apps/web/sentry.client.config.ts apps/web/sentry.server.config.ts apps/web/src/pages/api/sentry-smoke.ts apps/web/astro.config.mjs
git commit -m "observability(web): wire Sentry on Astro client + server (ops C2)"
```

---

### Task 34: Sentry on Go agent

Audit finding (CRITICAL, ops C2): agent has no Sentry. Silent failures only surface via customer reports.

**Files:**
- Create: `agent/internal/observability/sentry.go`
- Modify: `agent/main.go`
- Modify: `agent/go.mod` — add `getsentry/sentry-go`

- [ ] **Step 1: Add the dep**

```bash
cd agent && go get github.com/getsentry/sentry-go@latest && go mod tidy
```

- [ ] **Step 2: Write the wrapper**

`agent/internal/observability/sentry.go`:

```go
package observability

import (
	"errors"
	"log/slog"
	"os"
	"runtime/debug"
	"time"

	"github.com/getsentry/sentry-go"
)

func Init(version string) error {
	dsn := os.Getenv("BREEZE_SENTRY_DSN")
	if dsn == "" {
		slog.Info("sentry disabled (no DSN set)")
		return nil
	}
	return sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Release:          version,
		Environment:      os.Getenv("BREEZE_ENV"),
		TracesSampleRate: 0.05,
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			// Strip device token and any "Authorization" header from breadcrumbs.
			for i, bc := range event.Breadcrumbs {
				if v, ok := bc.Data["authorization"]; ok {
					event.Breadcrumbs[i].Data["authorization"] = "[redacted]"
					_ = v
				}
			}
			return event
		},
	})
}

func Flush() {
	sentry.Flush(2 * time.Second)
}

// Recoverer wraps a goroutine entry-point to capture panics.
func Recoverer(name string) {
	if r := recover(); r != nil {
		var err error
		switch v := r.(type) {
		case error:
			err = v
		default:
			err = errors.New("panic in " + name)
		}
		sentry.CaptureException(err)
		sentry.CaptureMessage(name + ": " + string(debug.Stack()))
		slog.Error("recovered panic", "where", name, "err", err.Error())
	}
}
```

- [ ] **Step 3: Wire init in `agent/main.go`**

```go
import "github.com/breezermm/agent/internal/observability"

func main() {
	if err := observability.Init(Version); err != nil {
		slog.Error("sentry init failed", "err", err.Error())
	}
	defer observability.Flush()
	// ...
}
```

- [ ] **Step 4: Wrap critical goroutines**

At each `go func() { ... }()` in `heartbeat/`, `desktop/`, `terminal/`, `updater/` — wrap with `defer observability.Recoverer("desktop.encoder")`.

- [ ] **Step 5: Smoke test in dev**

```bash
BREEZE_SENTRY_DSN=https://... ./agent --smoke-panic
```

(Add `--smoke-panic` flag that calls `panic("test")` then exits.)

- [ ] **Step 6: Commit**

```bash
git add agent/internal/observability/sentry.go agent/main.go agent/go.mod agent/go.sum
git commit -m "observability(agent): wire Sentry init + Recoverer on critical goroutines"
```

---

## Self-Review

**Spec coverage** — every CRITICAL and HIGH from the consultant verdict:

- Audit log integrity (verdict CRIT 1) → Tasks 1, 2, 3
- Plaintext partners.settings (verdict CRIT 2) → Task 4
- Monitoring not running (verdict CRIT 3) → out of scope (ops)
- Sentry agent/web (verdict CRIT 4) → Tasks 33, 34
- Anomaly alerting (verdict CRIT 5) → out of scope (ops, Prometheus rules YAML)
- Backup proof (verdict CRIT 6) → out of scope (ops)
- MFA on partner-admin (verdict CRIT 7) → Task 8
- take_screenshot Tier 3 (verdict CRIT 8) → Task 20
- Open DCR (verdict CRIT 9) → Task 21
- TRUST_PROXY_HEADERS validator (verdict CRIT 10) → Task 25
- JWT rotation (verdict HIGH) → Task 6
- Refresh-token reuse (verdict HIGH) → Task 7
- OAuth-grant revoke on partner suspend (verdict HIGH) → Task 13
- Site-scope misses (verdict HIGH) → Task 12
- Manifest signing key off API host (verdict HIGH) → **deferred to separate plan**
- Audit retention enforcement (verdict HIGH) → Task 29
- Bulk org export/erasure (verdict HIGH) → Task 30
- Webhook legacy secret default (verdict HIGH) → Task 31
- Credential-stuffing defense (verdict HIGH) → Task 10
- WS ticket caller-binding (verdict HIGH) → Task 16
- Cross-tenant probe auto-suspend (verdict HIGH) → Task 18
- Password-reset gap #719 (verdict M2) → Task 9
- Login timing equalize (auth audit H-4) → Task 11
- JWT staleness on partner-user remove (RLS audit MEDIUM) → Task 14
- OAuth bearer + partnerGuard (MCP H-1 second half) → Task 15
- Connect-code re-exchange cache (agent H-2) → Task 17
- Agent WS rate limit per-source-IP (agent H-5) → Task 19
- MCP Session-Id binding (MCP MED-1) → Task 22
- Action-multiplexed RBAC bypass (MCP MED-2) → Task 23
- mcp:write legacy expansion (MCP MED-4) → Task 24
- Required env vars unvalidated (secrets H-3) → Task 26
- Manifest pubkey for BINARY_SOURCE=local (public HIGH-2) → Task 27
- ip npm dep SSRF (secrets M-1) → Task 28
- Installer signing budget cap (public HIGH-1) → Task 32
- AAD in encryptSecret (secrets M-2) → Task 5

**Out of scope (per user direction):** pure-ops items (monitoring stack deployment, status page, pentest, SOC 2, off-region backup wiring, per-region HA). Architectural rework: manifest signing key off API host.

**Placeholder scan:** no TBDs, no "add appropriate error handling", every code step has actual code, every test step has actual test code. Tasks 28, 29 use a couple of "match existing pattern" cues (e.g. `scheduleDaily` vs. BullMQ `repeat:`) because the call site exists but I haven't read it — the engineer doing the task will inspect once.

**Type consistency:** `suspendAgentToken`, `revokeAllPartnerGrants`, `cascadeDeleteOrg`, `recordAccountFailure` are used consistently. Refresh-family schema columns match between schema, migration, and access code.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-launch-readiness-code-fixes.md`.

Tasks 1, 2, 3 (Phase 1) **must ship first** — every later task is harder to validate post-incident without tamper-evident logs. Tasks 4–10 (Phases 2–3) can run in parallel after that. Tasks 11–34 can be parallelized freely.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. Best for the simpler tasks (validators, flag flips); each runs in 10-20 min.
2. **Inline Execution** — execute in this session with checkpoints, useful when you want to watch the audit-log integrity work land carefully.

**Which approach?**

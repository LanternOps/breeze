# Microsoft 365 Ticket Mailbox Consent Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsigned Microsoft tenant callback trust with verified administrator identity and database-enforced partner ownership while adding least-privilege authorization, audit coverage, safe UI behavior, and a mandatory re-consent rollout.

**Architecture:** Use a two-phase, single-use server-side consent session: Microsoft admin consent supplies only a tenant hint, then a tenant-specific OIDC authorization-code flow with PKCE and nonce cryptographically verifies the tenant and accepted administrator role. Persist the normalized verified tenant in a globally unique partner ownership table and require a same-partner composite foreign key before a connection may become `connected`; polling and outbound Graph resolution join this ownership record. Keep internal connection rows private behind an explicit list DTO, and gate the partner-global lifecycle with dedicated permissions, MFA, and `partnerOrgAccess === 'all'`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL 16 with forced RLS, `jose`, React, Vitest, OrbStack Docker.

## Global Constraints

- This plan implements only Wave 1 findings SR1-01, SR1-08, and SR1-25 from `docs/superpowers/specs/security-auth/2026-07-11-security-review-remediation-design.md`.
- Do not edit the shipped migration `apps/api/migrations/2026-06-29-ticket-mailbox-connections.sql`.
- Use hand-written, date-prefixed, idempotent migrations; use explicit `-a-` / `-b-` ordering for same-day dependencies.
- New tenant-scoped tables must enable and force RLS, add partner policies, join `PARTNER_TENANT_TABLES`, and pass real-PostgreSQL forge tests.
- Lifecycle writes require `ticket_mailbox:admin`, MFA, and system or partner scope with `partnerOrgAccess === 'all'`; list requires `ticket_mailbox:read`.
- Accept only Global Administrator (`62e90394-69f5-4237-9190-012177145e10`) and Privileged Role Administrator (`e8611ab8-c189-46e8-94e1-60213ab1f814`) in the verified `wids` claim.
- Never persist or probe the admin-consent `tenant` query value; only the signature-verified ID-token `tid` may reach ownership binding or app-only token acquisition.
- Non-disabled connections and disabled rows retaining legacy tenant/cursor state become `reauth_required`, lose `tenant_id` and `delta_link`, and remain excluded from polling and outbound Graph replies until verified again. Already-disabled clean rows remain disabled.
- Audit details must not contain authorization codes, access/ID tokens, PKCE verifiers, nonce values, delta links, or raw Graph errors/responses.
- Use test-driven development: demonstrate each security regression red before production changes and green after them.
- Use OrbStack for PostgreSQL-backed tests: `PATH="$HOME/.orbstack/bin:$PATH" docker-compose -f docker-compose.test.yml up -d --wait`.

---

## File and interface map

### New files

- `apps/api/migrations/2026-07-15-a-ticket-mailbox-verified-ownership.sql` — creates ownership/session tables, migrates legacy connections, and installs database guards and RLS.
- `apps/api/migrations/2026-07-15-b-ticket-mailbox-permissions.sql` — inserts read/admin permissions and conservative system-role grants.
- `apps/api/src/services/ticketMailbox/consentSessionService.ts` — creates and atomically consumes short-lived browser-bound consent sessions.
- `apps/api/src/services/ticketMailbox/consentSessionService.test.ts` — single-use, phase, expiry, and partner/session behavior.
- `apps/api/src/services/ticketMailbox/microsoftIdentity.ts` — fixed-host Microsoft authorization, token exchange, signature/claim verification, and administrator-role checks.
- `apps/api/src/services/ticketMailbox/microsoftIdentity.test.ts` — issuer, audience, expiry, nonce, tenant, role, and redirect hardening tests.
- `apps/api/src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts` — real-database legacy migration, ownership, composite-FK, connected guard, and RLS forge tests.
- `docs/release-notes/m365-ticket-mailbox-reconsent.md` — operator-facing action-required guide.

### Modified files

- `packages/shared/src/constants/permissions.ts` — canonical mailbox read/admin permission literals.
- `apps/api/src/db/seed.ts`, `apps/api/src/db/seed.test.ts` — permission rows and default partner role assignments.
- `apps/api/src/db/schema/ticketMailbox.ts`, `apps/api/src/db/schema/index.ts` — ownership/session Drizzle tables and connection constraints.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — partner-axis table allowlist.
- `apps/api/src/services/ticketMailbox/connectionService.ts` and test — public DTO, atomic verified binding, safe reconnect reset, and verified-only active queries.
- `apps/api/src/routes/tickets/mailboxConnect.ts` and test — authorization matrix, two-stage callback, sanitized audit, and safe retest/disable behavior.
- `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts` and test — verified-ownership join for outbound Graph mail.
- `apps/api/src/jobs/ticketMailboxPollWorker.test.ts` — regression proving inactive/unverified mailboxes cause no Graph work.
- `apps/web/src/components/settings/M365MailboxCard.tsx` and test — reduced DTO, permission-aware controls, reconnect action, and sanitized messages.
- `apps/web/src/components/settings/TicketingSettingsTabs.tsx` and test — mailbox-read visibility.
- `CHANGELOG.md`, `UPGRADING.md` — breaking re-consent and rollback guidance.

---

### Task 1: Register and seed mailbox permissions

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/db/seed.test.ts`
- Create: `apps/api/migrations/2026-07-15-b-ticket-mailbox-permissions.sql`

**Interfaces:**
- Consumes: existing `PERMISSION_GRANTS`, `DEFAULT_PERMISSIONS`, and `SYSTEM_ROLES` registries.
- Produces: `PERMISSIONS.TICKET_MAILBOX_READ` as `{ resource: 'ticket_mailbox', action: 'read' }` and `PERMISSIONS.TICKET_MAILBOX_ADMIN` as `{ resource: 'ticket_mailbox', action: 'admin' }` for Tasks 6 and 8.

- [ ] **Step 1: Add failing registry and role tests**

Add assertions to `apps/api/src/db/seed.test.ts`:

```ts
it('registers and seeds the ticket mailbox permissions', () => {
  expect(PERMISSION_GRANTS.TICKET_MAILBOX_READ).toEqual({ resource: 'ticket_mailbox', action: 'read' });
  expect(PERMISSION_GRANTS.TICKET_MAILBOX_ADMIN).toEqual({ resource: 'ticket_mailbox', action: 'admin' });
  expect(DEFAULT_PERMISSIONS).toEqual(expect.arrayContaining([
    expect.objectContaining({ resource: 'ticket_mailbox', action: 'read' }),
    expect.objectContaining({ resource: 'ticket_mailbox', action: 'admin' }),
  ]));
});

it('grants mailbox read to partner technicians/viewers but not mailbox admin', () => {
  for (const roleName of ['Partner Technician', 'Partner Viewer']) {
    const role = SYSTEM_ROLES.find((candidate) => candidate.name === roleName)!;
    expect(role.permissions).toContain('ticket_mailbox:read');
    expect(role.permissions).not.toContain('ticket_mailbox:admin');
  }
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `pnpm -C apps/api exec vitest run src/db/seed.test.ts`

Expected: FAIL because `TICKET_MAILBOX_READ`, `TICKET_MAILBOX_ADMIN`, and role grants do not exist.

- [ ] **Step 3: Add the canonical permission literals and seed definitions**

Insert in `PERMISSION_GRANTS`:

```ts
// Microsoft 365 partner-global ticket mailbox administration
TICKET_MAILBOX_READ: { resource: 'ticket_mailbox', action: 'read' },
TICKET_MAILBOX_ADMIN: { resource: 'ticket_mailbox', action: 'admin' },
```

Insert in `DEFAULT_PERMISSIONS`:

```ts
{ resource: 'ticket_mailbox', action: 'read', description: 'View Microsoft 365 ticket mailbox connection status' },
{ resource: 'ticket_mailbox', action: 'admin', description: 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes' },
```

Add `'ticket_mailbox:read'` to Partner Technician and Partner Viewer. Partner Admin continues to inherit both through `*:*`; do not grant admin to any other built-in or custom role.

- [ ] **Step 4: Add the idempotent permission migration**

Create `apps/api/migrations/2026-07-15-b-ticket-mailbox-permissions.sql` with explicit permission inserts and system-role assignment by resource/action:

```sql
INSERT INTO permissions (resource, action, description)
VALUES
  ('ticket_mailbox', 'read', 'View Microsoft 365 ticket mailbox connection status'),
  ('ticket_mailbox', 'admin', 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes')
ON CONFLICT (resource, action) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.resource = 'ticket_mailbox'
 AND p.action = 'read'
WHERE r.is_system = true
  AND r.scope = 'partner'
  AND r.name IN ('Partner Admin', 'Partner Technician', 'Partner Viewer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.resource = 'ticket_mailbox'
 AND p.action = 'admin'
WHERE r.is_system = true
  AND r.scope = 'partner'
  AND r.name = 'Partner Admin'
ON CONFLICT DO NOTHING;
```

- [ ] **Step 5: Run the focused tests and type registry checks**

Run: `pnpm -C apps/api exec vitest run src/db/seed.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the permission slice**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts apps/api/migrations/2026-07-15-b-ticket-mailbox-permissions.sql
git commit -m "fix(authz): add ticket mailbox permissions"
```

---

### Task 2: Add verified tenant ownership and consent-session storage

**Files:**
- Modify: `apps/api/src/db/schema/ticketMailbox.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-07-15-a-ticket-mailbox-verified-ownership.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts`

**Interfaces:**
- Consumes: `partners`, `users`, and `ticketMailboxConnections` schema definitions.
- Produces: `ticketMailboxTenantOwnerships`, `ticketMailboxConsentSessions`, `TicketMailboxConsentPhase`, a UUID `ticketMailboxConnections.tenantId`, same-partner composite FK, and the invariant `status <> 'connected' OR tenant_id IS NOT NULL`.

- [ ] **Step 1: Write a real-database regression suite**

Create tests that migrate a pre-hardening fixture and assert these exact database outcomes:

```ts
expect(legacyConnection.status).toBe('reauth_required');
expect(legacyConnection.tenantId).toBeNull();
expect(legacyConnection.deltaLink).toBeNull();

await expect(appSql`
  UPDATE ticket_mailbox_connections
  SET status = 'connected', tenant_id = NULL
  WHERE id = ${connectionId}
`).rejects.toThrow(/ticket_mailbox_connections_connected_requires_verified_tenant/);

await expect(appSql`
  INSERT INTO ticket_mailbox_tenant_ownerships (tenant_id, partner_id, verified_by)
  VALUES (${tenantId}, ${otherPartnerId}, ${otherUserId})
`).rejects.toThrow(/duplicate key|unique/i);
```

Also prove that a connection can reference `(tenant_id, partner_id)` only when both columns match one ownership row, and that `breeze_app` cannot select or insert an ownership/session row for another partner under forged request context.

- [ ] **Step 2: Run the new integration test and confirm red**

Start OrbStack services:

```bash
PATH="$HOME/.orbstack/bin:$PATH" docker-compose -f docker-compose.test.yml up -d --wait
```

Run: `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm -C apps/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts`

Expected: FAIL because both tables and the connected-row constraint are absent.

- [ ] **Step 3: Define the Drizzle tables and exact columns**

Add these schema shapes in `ticketMailbox.ts`:

```ts
export const ticketMailboxTenantOwnerships = pgTable('ticket_mailbox_tenant_ownerships', {
  tenantId: uuid('tenant_id').primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedMicrosoftOid: uuid('verified_microsoft_oid').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPartnerIdx: uniqueIndex('ticket_mailbox_tenant_ownerships_tenant_partner_idx')
    .on(table.tenantId, table.partnerId),
}));

export type TicketMailboxConsentPhase = 'admin_consent' | 'identity_verification';

export const ticketMailboxConsentSessions = pgTable('ticket_mailbox_consent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull().unique(),
  phase: varchar('phase', { length: 24 }).notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  connectionId: uuid('connection_id').notNull(),
  userId: uuid('user_id').references(() => users.id),
  tenantHintHash: text('tenant_hint_hash'),
  nonce: text('nonce'),
  codeVerifier: text('code_verifier'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Change `ticketMailboxConnections.tenantId` from `text` to `uuid` and add a foreign key over `tenantId, partnerId` to `ticketMailboxTenantOwnerships.tenantId, partnerId`. Export both new tables from `db/schema/index.ts`.

- [ ] **Step 4: Write the additive, idempotent migration**

The migration must execute in this order:

```sql
CREATE TABLE IF NOT EXISTS ticket_mailbox_tenant_ownerships (
  tenant_id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  verified_by uuid REFERENCES users(id),
  verified_microsoft_oid uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_mailbox_tenant_ownerships_tenant_partner_unique UNIQUE (tenant_id, partner_id)
);

CREATE TABLE IF NOT EXISTS ticket_mailbox_consent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL UNIQUE,
  phase varchar(24) NOT NULL CHECK (phase IN ('admin_consent', 'identity_verification')),
  partner_id uuid NOT NULL REFERENCES partners(id),
  connection_id uuid NOT NULL,
  user_id uuid REFERENCES users(id),
  tenant_hint_hash text,
  nonce text,
  code_verifier text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_mailbox_consent_sessions_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES ticket_mailbox_connections(id, partner_id) ON DELETE CASCADE
);

DO $$
DECLARE affected bigint;
BEGIN
  UPDATE ticket_mailbox_connections
  SET status = 'reauth_required', tenant_id = NULL, delta_link = NULL,
      last_error = NULL, updated_at = now()
  WHERE status <> 'disabled' OR tenant_id IS NOT NULL OR delta_link IS NOT NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE WARNING 'ticket mailbox hardening marked % legacy connection(s) reauth_required and cleared tenant/cursor state', affected;
END $$;

ALTER TABLE ticket_mailbox_connections
  ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_tenant_partner_fk;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_tenant_partner_fk
  FOREIGN KEY (tenant_id, partner_id)
  REFERENCES ticket_mailbox_tenant_ownerships(tenant_id, partner_id);

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_connected_requires_verified_tenant;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_connected_requires_verified_tenant
  CHECK (status <> 'connected' OR tenant_id IS NOT NULL);
```

Wrap `ALTER COLUMN ... TYPE` in an information-schema guard so reapplication does not recast UUID. Add `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and `breeze_has_partner_access(partner_id)` policies for SELECT/INSERT/UPDATE/DELETE on both new tables using the existing partner-table migration pattern.

- [ ] **Step 5: Add RLS coverage allowlist entries**

Add to `PARTNER_TENANT_TABLES`:

```ts
['ticket_mailbox_tenant_ownerships', 'partner_id'],
['ticket_mailbox_consent_sessions', 'partner_id'],
```

- [ ] **Step 6: Run migration, forge, and coverage tests green**

Run:

```bash
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm -C apps/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm -C apps/api run test:rls-coverage
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
```

Expected: all commands PASS; cross-partner inserts and connections fail with RLS/FK errors, while same-partner verified binding succeeds.

- [ ] **Step 7: Commit storage and migration**

```bash
git add apps/api/src/db/schema/ticketMailbox.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-07-15-a-ticket-mailbox-verified-ownership.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts
git commit -m "fix(security): enforce verified mailbox tenant ownership"
```

---

### Task 3: Implement single-use consent sessions

**Files:**
- Create: `apps/api/src/services/ticketMailbox/consentSessionService.ts`
- Create: `apps/api/src/services/ticketMailbox/consentSessionService.test.ts`

**Interfaces:**
- Consumes: `ticketMailboxConsentSessions` from Task 2 and `generateState`, `generateNonce`, `generatePKCEChallenge` from `services/sso.ts`.
- Produces: `createAdminConsentSession`, `createIdentityVerificationSession`, and `consumeConsentSession` with the signatures below.

- [ ] **Step 1: Write failing single-use and phase tests**

Exercise these contracts with mocked Drizzle chains:

```ts
const first = await consumeConsentSession('state-1', 'admin_consent');
const replay = await consumeConsentSession('state-1', 'admin_consent');
expect(first).toMatchObject({ partnerId, connectionId, userId, phase: 'admin_consent' });
expect(replay).toBeNull();

mockDeleteReturning.mockResolvedValueOnce([]);
await expect(consumeConsentSession('expired-state', 'admin_consent')).resolves.toBeNull();
expect(mockDeleteWhere).toHaveBeenCalledTimes(3);
```

Cover expired rows, wrong phase, state collision, and identity sessions requiring tenant hint, nonce, and code verifier.

- [ ] **Step 2: Run the new tests and confirm red**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/consentSessionService.test.ts`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement the service with exact public types**

```ts
export interface ConsentSession {
  state: string;
  phase: TicketMailboxConsentPhase;
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHintHash: string | null;
  nonce: string | null;
  codeVerifier: string | null;
  expiresAt: Date;
}

export async function createAdminConsentSession(input: {
  partnerId: string;
  connectionId: string;
  userId: string | null;
}): Promise<ConsentSession>;

export async function createIdentityVerificationSession(input: {
  partnerId: string;
  connectionId: string;
  userId: string | null;
  tenantHint: string;
}): Promise<{ session: ConsentSession; codeChallenge: string }>;

export async function consumeConsentSession(
  state: string,
  phase: TicketMailboxConsentPhase,
): Promise<ConsentSession | null>;
```

Use a 10-minute TTL. Persist only a keyed HMAC of the normalized identity-phase tenant hint; carry the raw normalized hint solely in a phase/state-bound signed HttpOnly browser cookie. Delete expired session rows during creation. `consumeConsentSession` must perform one `DELETE ... WHERE state = ? AND phase = ? AND expires_at > now() RETURNING *` inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`; never select then delete.

- [ ] **Step 4: Run consent-session tests green**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/consentSessionService.test.ts`

Expected: PASS, including replay returning null.

- [ ] **Step 5: Commit session service**

```bash
git add apps/api/src/services/ticketMailbox/consentSessionService.ts apps/api/src/services/ticketMailbox/consentSessionService.test.ts
git commit -m "fix(security): add single-use mailbox consent sessions"
```

---

### Task 4: Verify Microsoft administrator identity

**Files:**
- Create: `apps/api/src/services/ticketMailbox/microsoftIdentity.ts`
- Create: `apps/api/src/services/ticketMailbox/microsoftIdentity.test.ts`

**Interfaces:**
- Consumes: `getMailboxPlatformConfig()` and `jose` remote-JWKS verification.
- Produces: authorization URL construction, code exchange, verified claims, and explicit admin role predicate.

- [ ] **Step 1: Write failing verification tests**

Use dependency injection for token verification/fetch so unit tests never call Microsoft. Assert:

```ts
expect(hasMailboxConsentAdminRole([GLOBAL_ADMIN_ROLE_ID])).toBe(true);
expect(hasMailboxConsentAdminRole([PRIVILEGED_ROLE_ADMIN_ROLE_ID])).toBe(true);
expect(hasMailboxConsentAdminRole(['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3'])).toBe(false);
expect(hasMailboxConsentAdminRole([])).toBe(false);

await expect(verifyMicrosoftAdminIdToken(token, expected)).rejects.toThrow('Microsoft tenant mismatch');
await expect(exchangeMicrosoftAuthorizationCode({ ...input, code: 'bad' })).rejects.toThrow('Microsoft identity verification failed');
```

Add distinct tests for invalid signature, issuer, audience, expiry, nonce, missing/malformed `tid`, missing/malformed `oid`, unknown/missing `wids`, token endpoint non-2xx, and `redirect: 'error'` on token fetch.

- [ ] **Step 2: Run the identity tests and confirm red**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/microsoftIdentity.test.ts`

Expected: FAIL because the identity service is absent.

- [ ] **Step 3: Implement fixed-host authorization and exchange**

Define these exports:

```ts
export const GLOBAL_ADMIN_ROLE_ID = '62e90394-69f5-4237-9190-012177145e10';
export const PRIVILEGED_ROLE_ADMIN_ROLE_ID = 'e8611ab8-c189-46e8-94e1-60213ab1f814';

export interface MicrosoftAdminIdTokenClaims {
  tid: string;
  oid: string;
  sub: string;
  wids: string[];
}

export function buildMicrosoftAuthorizationUrl(input: {
  tenantHint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string;

export async function exchangeMicrosoftAuthorizationCode(input: {
  tenantHint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{ idToken: string }>;

export async function verifyMicrosoftAdminIdToken(
  idToken: string,
  expected: { tenantHint: string; clientId: string; nonce: string },
): Promise<MicrosoftAdminIdTokenClaims>;

export function hasMailboxConsentAdminRole(wids: readonly string[]): boolean;
```

Build only `https://login.microsoftonline.com/<validated-guid>/oauth2/v2.0/authorize` and `/token` URLs. Request `openid profile`, `response_type=code`, `response_mode=query`, and `code_challenge_method=S256`. Verify with Microsoft JWKS and require audience `clientId`, issuer `https://login.microsoftonline.com/${tid}/v2.0`, nonce equality, unexpired token, normalized `tid === tenantHint`, UUID `oid`, and an accepted `wids` element. Throw only stable sanitized error classes/messages; do not attach token response bodies.

- [ ] **Step 4: Run identity tests green**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/microsoftIdentity.test.ts`

Expected: PASS for both accepted role GUIDs and all rejection cases.

- [ ] **Step 5: Commit identity verification**

```bash
git add apps/api/src/services/ticketMailbox/microsoftIdentity.ts apps/api/src/services/ticketMailbox/microsoftIdentity.test.ts
git commit -m "fix(security): verify mailbox consent administrator identity"
```

---

### Task 5: Bind verified ownership atomically and minimize connection reads

**Files:**
- Modify: `apps/api/src/services/ticketMailbox/connectionService.ts`
- Modify: `apps/api/src/services/ticketMailbox/connectionService.test.ts`

**Interfaces:**
- Consumes: `ticketMailboxTenantOwnerships` and connection constraints from Task 2.
- Produces: `MailboxConnectionListItem`, `bindVerifiedTenant`, and verified-only active queries for routes/workers.

- [ ] **Step 1: Write failing service regressions**

Add tests proving reconnect clears stale fields and only a verified tenant can activate:

```ts
expect(upsertSet).toMatchObject({
  status: 'pending_consent',
  tenantId: null,
  deltaLink: null,
  lastError: null,
});

await bindVerifiedTenant(connectionId, partnerId, tenantId, {
  microsoftOid,
  breezeUserId,
});
expect(transactionCalls).toEqual([
  'claim-or-verify-global-tenant',
  'bind-same-partner-connection',
  'mark-connected',
]);
```

Test uniqueness conflict from another partner, missing connection, list DTO exact keys, and `listConnectedMailboxes` joining the ownership table. Probe-failure ownership behavior belongs to the callback route in Task 6 because the connection service never performs Microsoft Graph probes.

- [ ] **Step 2: Run the service tests and confirm red**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/connectionService.test.ts`

Expected: FAIL because reconnect retains legacy data and verified binding does not exist.

- [ ] **Step 3: Add exact public DTO and verified binding interface**

```ts
export interface MailboxConnectionListItem {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
}

export async function bindVerifiedTenant(
  connectionId: string,
  partnerId: string,
  tenantId: string,
  evidence: { microsoftOid: string; breezeUserId: string | null },
): Promise<void>;
```

Return list items by explicit column selection, never object spreading. Normalize tenant and OID UUIDs to lowercase. In one Drizzle transaction: insert ownership with global tenant uniqueness; if it exists, require the same partner; update the pending connection with the verified tenant and `status='connected'`; require exactly one updated row or throw. Rely on the unique/FK constraints to serialize cross-partner claims.

- [ ] **Step 4: Make all activation paths fail closed**

Update `createPendingConnection` conflict handling to clear `tenantId`, `deltaLink`, `lastError`, `lastPolledAt`, and `lastMessageAt`. Remove `setConnectionTenant`. Prevent generic `setConnectionStatus` from setting `connected`; only `bindVerifiedTenant` may activate. Make `listConnectedMailboxes` select connections through an inner join on both tenant and partner.

- [ ] **Step 5: Run service tests green**

Run: `pnpm -C apps/api exec vitest run src/services/ticketMailbox/connectionService.test.ts`

Expected: PASS; public DTO contains no `partnerId`, `tenantId`, `deltaLink`, `lastError`, or `createdBy`.

- [ ] **Step 6: Commit connection hardening**

```bash
git add apps/api/src/services/ticketMailbox/connectionService.ts apps/api/src/services/ticketMailbox/connectionService.test.ts
git commit -m "fix(security): bind verified mailbox tenant ownership"
```

---

### Task 6: Replace the callback and enforce lifecycle authorization/audit

**Files:**
- Modify: `apps/api/src/routes/tickets/mailboxConnect.ts`
- Modify: `apps/api/src/routes/tickets/mailboxConnect.test.ts`

**Interfaces:**
- Consumes: permission constants from Task 1; session methods from Task 3; identity methods from Task 4; `bindVerifiedTenant` and reduced list from Task 5; `canManagePartnerWidePolicies`; `writeRouteAudit` and `writeAuditEvent`.
- Produces: hardened `POST /connect`, dual-phase `GET /callback`, safe `POST /connections/:id/retest`, `DELETE /connections/:id`, and exact audit actions.

- [ ] **Step 1: Replace vulnerable-route tests with a full authorization matrix**

For list, assert unauthenticated/wrong scope/missing-read denial and read-only success. For every lifecycle mutation, assert missing admin, missing MFA, `partnerOrgAccess='selected'`, and `partnerOrgAccess='none'` return 403 and call none of `createPendingConnection`, `probeMailbox`, `bindVerifiedTenant`, or audit writers.

Add the central injection regression:

```ts
const response = await app.request(
  `/callback?state=${adminState}&tenant=${attackerTenant}&admin_consent=True`,
  { headers: { cookie: matchingCookie } },
);
expect(response.status).toBe(302);
expect(createIdentityVerificationSession).toHaveBeenCalledWith(
  expect.objectContaining({ tenantHint: attackerTenant }),
);
expect(probeMailbox).not.toHaveBeenCalled();
expect(bindVerifiedTenant).not.toHaveBeenCalled();
```

Then test the identity callback: valid code uses the verified token `tid`; query injection cannot override it; invalid role/issuer/audience/nonce/tenant/code fails without probe/bind; replayed state fails; cross-partner ownership conflict fails; and only the stored connection mailbox is probed.
Explicitly assert a failed mailbox probe never calls `bindVerifiedTenant`, leaving ownership and connection state unbound.

- [ ] **Step 2: Run route tests and confirm red**

Run: `pnpm -C apps/api exec vitest run src/routes/tickets/mailboxConnect.test.ts`

Expected: FAIL because the callback still persists/probes the unsigned tenant and routes lack permission/full-partner gates.

- [ ] **Step 3: Add middleware and full-partner gates**

Define:

```ts
const requireMailboxRead = requirePermission(
  PERMISSIONS.TICKET_MAILBOX_READ.resource,
  PERMISSIONS.TICKET_MAILBOX_READ.action,
);
const requireMailboxAdmin = requirePermission(
  PERMISSIONS.TICKET_MAILBOX_ADMIN.resource,
  PERMISSIONS.TICKET_MAILBOX_ADMIN.action,
);
```

Mount `requireMailboxRead` on list. Mount `requireMailboxAdmin` and `requireMfa()` on connect, retest, and delete. Before any lifecycle service call:

```ts
if (!canManagePartnerWidePolicies(auth)) {
  return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
}
```

- [ ] **Step 4: Implement the two callback phases**

`POST /connect` creates a pending connection and `admin_consent` session, binds its state to an HttpOnly SameSite=Lax cookie, audits `ticket_mailbox.consent_initiated`, and returns the Microsoft admin-consent URL.

On the admin-consent redirect, validate cookie, atomically consume only `admin_consent`, accept `tenant` only as a normalized OIDC endpoint hint, create an `identity_verification` session, rotate the browser-binding cookie to the new state, and redirect to `buildMicrosoftAuthorizationUrl`. It must not call `probeMailbox`, `bindVerifiedTenant`, or any tenant persistence function.

On the authorization-code redirect, validate cookie, atomically consume only `identity_verification`, exchange with stored PKCE verifier, verify the ID token with stored nonce/client/tenant hint, require an accepted role, load the stored connection mailbox, probe with `claims.tid`, then call `bindVerifiedTenant(..., { microsoftOid: claims.oid, breezeUserId: session.userId })` only if the probe succeeds.

- [ ] **Step 5: Add exactly-once sanitized audit events**

Use these action names and details:

```ts
const details = {
  partnerId: session.partnerId,
  connectionId: session.connectionId,
  mailboxAddress: connection.mailboxAddress,
  ...(verifiedTenantId ? { verifiedTenantId } : {}),
  outcome: 'verified',
};
```

- `ticket_mailbox.consent_initiated` from the authenticated route via `writeRouteAudit`.
- `ticket_mailbox.tenant_binding_verified` from verified callback state via `writeAuditEvent` with `actorId: session.userId`.
- `ticket_mailbox.verification_failed` once per consumed callback session with a stable outcome code such as `invalid_identity`, `insufficient_role`, `probe_failed`, or `ownership_conflict`; omit raw exception and Microsoft bodies.
- `ticket_mailbox.retested` after a verified existing ownership is probed.
- `ticket_mailbox.disabled` after disable succeeds.

- [ ] **Step 6: Make retest safe**

Retest must return 409 with `{ error: 'Mailbox re-consent required' }` for `reauth_required`, pending, unverified, or tenantless rows. It may probe only a currently verified tenant and may never transition an unverified row to connected.

- [ ] **Step 7: Run route tests green**

Run: `pnpm -C apps/api exec vitest run src/routes/tickets/mailboxConnect.test.ts`

Expected: PASS with each audit action called exactly once and no sensitive values present in serialized audit inputs.

- [ ] **Step 8: Commit route hardening**

```bash
git add apps/api/src/routes/tickets/mailboxConnect.ts apps/api/src/routes/tickets/mailboxConnect.test.ts
git commit -m "fix(security): harden mailbox consent and lifecycle authz"
```

---

### Task 7: Gate polling and outbound Graph mail on verified ownership

**Files:**
- Modify: `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts`
- Modify: `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.test.ts`
- Modify: `apps/api/src/jobs/ticketMailboxPollWorker.test.ts`
- Modify: `apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts`

**Interfaces:**
- Consumes: verified ownership join and `listConnectedMailboxes` from Task 5.
- Produces: Graph polling/sending only for currently connected, same-partner verified ownership; unverified resolution remains `null` and preserves the existing SMTP fallback.

- [ ] **Step 1: Add fail-closed polling and outbound regressions**

Add tests asserting `reauth_required`, `disabled`, and malformed connected-without-ownership fixtures never produce token/Graph calls. For the resolver, model the ownership join returning no row:

```ts
mockConnectionJoin.mockResolvedValue([]);
expect(await resolveOutboundMailbox(ticketId, partnerId)).toBeNull();
expect(mockInboundSelect).not.toHaveBeenCalled();
```

In `ticketNotifyWorker.graphFork.test.ts`, prove a null verified resolver uses the existing `EmailService` fallback and does not call `sendThreadedReply` or `sendNewMail`.

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```bash
pnpm -C apps/api exec vitest run src/services/ticketMailbox/resolveOutboundMailbox.test.ts src/jobs/ticketMailboxPollWorker.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts
```

Expected: resolver test FAIL because it currently filters only on `status='connected'`; polling assertions fail until active selection uses the ownership join.

- [ ] **Step 3: Join ownership in the outbound resolver**

Inner join on both keys:

```ts
.innerJoin(
  ticketMailboxTenantOwnerships,
  and(
    eq(ticketMailboxTenantOwnerships.tenantId, ticketMailboxConnections.tenantId),
    eq(ticketMailboxTenantOwnerships.partnerId, ticketMailboxConnections.partnerId),
  ),
)
```

Retain partner and connected filters and existing first-row selection semantics. A missing verified row returns `null`, intentionally preserving SMTP fallback rather than suppressing customer mail.

- [ ] **Step 4: Run focused tests green**

Run the same three-file Vitest command.

Expected: PASS; verified connected fixtures still poll and use Graph, while all unverified/inactive fixtures perform no Graph call.

- [ ] **Step 5: Commit data-path gating**

```bash
git add apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts apps/api/src/services/ticketMailbox/resolveOutboundMailbox.test.ts apps/api/src/jobs/ticketMailboxPollWorker.test.ts apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts
git commit -m "fix(security): require verified mailbox ownership for Graph"
```

---

### Task 8: Update the mailbox UI for least privilege and re-consent

**Files:**
- Modify: `apps/web/src/components/settings/M365MailboxCard.tsx`
- Modify: `apps/web/src/components/settings/M365MailboxCard.test.tsx`
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.tsx`
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.test.tsx`

**Interfaces:**
- Consumes: `ticket_mailbox:read/admin` from Task 1 and `MailboxConnectionListItem` JSON from Task 5.
- Produces: read-gated mailbox surface, admin-gated controls, sanitized status copy, and reconnect behavior.

- [ ] **Step 1: Write failing permission and DTO tests**

Add cases proving:

```ts
expect(screen.queryByTestId('m365-mailbox-card')).not.toBeInTheDocument(); // no read
expect(screen.getByTestId('m365-mailbox-card')).toBeInTheDocument(); // read only
expect(screen.queryByTestId('m365-connect')).not.toBeInTheDocument(); // no admin
expect(screen.getByTestId('m365-reconnect')).toBeInTheDocument(); // admin + reauth
expect(screen.queryByText('raw Graph failure')).not.toBeInTheDocument();
expect(screen.queryByText('Re-test')).not.toBeInTheDocument();
```

Test malformed/unknown status input is discarded or rendered as a stable `Needs attention` state without crashing.

- [ ] **Step 2: Run web tests and confirm red**

Run:

```bash
pnpm -C apps/web exec vitest run src/components/settings/M365MailboxCard.test.tsx src/components/settings/TicketingSettingsTabs.test.tsx
```

Expected: FAIL because the card exposes controls to every partner-scoped viewer and renders `lastError`.

- [ ] **Step 3: Narrow and parse the DTO**

Use this client contract:

```ts
interface MailboxConnectionDTO {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  lastPolledAt: string | null;
  lastMessageAt: string | null;
}
```

Remove `tenantId` and `lastError`. Parse each object by allowlisted properties and known statuses; do not blindly cast response JSON.

- [ ] **Step 4: Gate visibility and controls**

Use `usePermissions()` and exact calls:

```ts
const { can } = usePermissions();
const canReadMailbox = can('ticket_mailbox', 'read');
const canAdminMailbox = can('ticket_mailbox', 'admin');
```

Render the settings card only when `canReadMailbox`. Hide connect/reconnect/retest/disconnect controls unless `canAdminMailbox`; the server remains authoritative for full-partner access and MFA.

- [ ] **Step 5: Replace raw errors and unsafe re-test copy**

For `reauth_required`, render: `Administrator re-consent is required before Microsoft 365 polling and replies resume.` Show a `Reconnect` button that reuses the selected row's mailbox/display name in `POST /connect`. Do not show Application Access Policy instructions or Re-test for `reauth_required`; retain Re-test only for a verified `error` connection.

- [ ] **Step 6: Run web tests green**

Run the same two-file Vitest command.

Expected: PASS for no-read, read-only, admin, reconnect, sanitized error, and unknown-status cases.

- [ ] **Step 7: Commit UI hardening**

```bash
git add apps/web/src/components/settings/M365MailboxCard.tsx apps/web/src/components/settings/M365MailboxCard.test.tsx apps/web/src/components/settings/TicketingSettingsTabs.tsx apps/web/src/components/settings/TicketingSettingsTabs.test.tsx
git commit -m "fix(web): require mailbox permissions and guide re-consent"
```

---

### Task 9: Document rollout and run the Wave 1 security gate

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `UPGRADING.md`
- Create: `docs/release-notes/m365-ticket-mailbox-reconsent.md`

**Interfaces:**
- Consumes: completed Tasks 1–8.
- Produces: operator action guide and final verification evidence.

- [ ] **Step 1: Add the action-required release note**

Document these exact operational facts:

- All existing Microsoft 365 ticket mailbox connections become `reauth_required` during upgrade.
- Inbound Microsoft polling and outbound Graph replies remain disabled until a full-partner mailbox admin with MFA completes consent again.
- SMTP fallback for outbound customer mail remains active when no verified Graph mailbox resolves.
- Deploy migration and API together, then deploy the web UI.
- Confirm no connection is `connected` without a matching `(tenant_id, partner_id)` ownership row.
- Rollback must keep the ownership tables, composite FK, connected-row check, and legacy rows disabled; do not restore unsigned callback behavior.

- [ ] **Step 2: Add CHANGELOG and UPGRADING entries**

Under Unreleased Security, state that M365 mailbox consent now verifies tenant/admin identity and requires re-consent. Add an `UPGRADING.md` top section with the deploy order, affected statuses, admin steps, post-deploy SQL verification, and rollback warning without publishing exploit mechanics.

- [ ] **Step 3: Run the complete focused unit suite**

```bash
pnpm -C apps/api exec vitest run \
  src/db/seed.test.ts \
  src/services/ticketMailbox/consentSessionService.test.ts \
  src/services/ticketMailbox/microsoftIdentity.test.ts \
  src/services/ticketMailbox/connectionService.test.ts \
  src/routes/tickets/mailboxConnect.test.ts \
  src/services/ticketMailbox/resolveOutboundMailbox.test.ts \
  src/jobs/ticketMailboxPollWorker.test.ts \
  src/jobs/ticketNotifyWorker.graphFork.test.ts
pnpm -C apps/web exec vitest run \
  src/components/settings/M365MailboxCard.test.tsx \
  src/components/settings/TicketingSettingsTabs.test.tsx
```

Expected: all focused API and web tests PASS.

- [ ] **Step 4: Run OrbStack-backed database security checks**

```bash
PATH="$HOME/.orbstack/bin:$PATH" docker-compose -f docker-compose.test.yml up -d --wait
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm -C apps/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketMailboxOwnership.rls.integration.test.ts
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm -C apps/api run test:rls-coverage
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
```

Expected: all commands PASS and the cross-partner forge cases fail closed inside the test assertions.

- [ ] **Step 5: Run package verification and inspect the diff**

```bash
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
pnpm -C apps/api exec vitest run src/__tests__/helpers/routeScan.test.ts
git diff --check
git status --short
```

Expected: both builds and route scan PASS; `git diff --check` prints nothing; status contains only intentional Wave 1 documentation changes before the final commit.

- [ ] **Step 6: Stop ephemeral OrbStack services**

```bash
PATH="$HOME/.orbstack/bin:$PATH" docker-compose -f docker-compose.test.yml down -v
```

Expected: test PostgreSQL and Redis containers/networks are removed.

- [ ] **Step 7: Commit rollout documentation**

```bash
git add CHANGELOG.md UPGRADING.md docs/release-notes/m365-ticket-mailbox-reconsent.md
git commit -m "docs(security): document mailbox re-consent rollout"
```

- [ ] **Step 8: Request security and code review before publishing**

Use `superpowers:requesting-code-review` against the complete branch. The review must explicitly re-check: unsigned tenant data never reaches persistence/probe, callback replay resistance, accepted-role allowlist, partner-global authorization matrix, same-partner/global uniqueness constraints, RLS policies/forge tests, audit payload secrecy, and fail-closed poll/outbound behavior.

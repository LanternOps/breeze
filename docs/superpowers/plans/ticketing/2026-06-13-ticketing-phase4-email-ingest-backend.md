# Ticketing Phase 4 — Email-to-Ticket Ingest Backend (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the inbound half of email-to-ticket: a HMAC-verified Mailgun webhook that enqueues raw envelopes, and a worker that logs them, resolves the partner from the recipient, thread-matches, and either appends a public comment, creates a `source:'email'` ticket, or quarantines unknown senders — all tenant-isolated by app-level guards.

**Architecture:** Thin Hono webhook route (verify + enqueue + 202) → BullMQ `ticket-email-inbound` queue → `inboundEmailWorker` running under `withSystemDbAccessContext` (matching `ticketSlaWorker`/`ticketNotifyWorker`). All processing logic lives in `services/inboundEmail/` (provider abstraction + resolver + dispatch service); the route and worker are thin. Two new partner-axis tables (`ticket_email_inbound`, `partner_inbound_domains`) ship RLS in the creating migration. Tenant isolation is **app-enforced** (system-context worker has no RLS net): partner-scoped read/match queries + write-boundary re-assertion guards (spec §6).

**Tech Stack:** Hono + Drizzle + Zod + BullMQ + Vitest. PostgreSQL RLS via `breeze_has_partner_access` / `breeze_current_scope`.

**Spec:** `docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md` (decisions D1–D5; §4 matching, §6 isolation).

**Scope of THIS plan (spec §11 PRs 1–2 = ingest core).** Outbound threading + autoresponder (PR3) and the Settings UI + review queue (PR4) are **separate plan docs** written after this lands. This plan delivers working, testable software on its own: an inbound email becomes a ticket / comment / quarantine row.

**Plan-level decisions (deltas/clarifications vs spec, decided here):**
- **Worker DB context:** `withSystemDbAccessContext` (precedent: `ticketSlaWorker`). Isolation is the two app-layers in §6 — verified by a real-driver cross-partner test (Task 12), not RLS.
- **Inbound comments are NOT written via `addTicketComment`** (that forces `authorType:'internal'`, `user_id=actor`). A dedicated `appendInboundComment` inserts `user_id=NULL`, `portal_user_id` (known sender) or `author_name`/`author_type='email'` (raw), `comment_type='comment'`, `is_public=true`. Under system scope the `ticket_comments` INSERT policy's `(user_id IS NULL AND breeze_current_scope()='system')` branch permits it.
- **No requester echo:** inbound public comments emit `ticket.commented` with `inbound:true`; this plan adds a one-line guard in `ticketNotifyWorker` so the existing "email the submitter on public comment" branch is skipped for inbound (otherwise we email the sender their own message). Tech-notification routing is refined in PR3.
- **Closed-ticket reopen:** `closed` tickets are immutable → create a NEW `source:'email'` ticket, carry the same `email_thread_key`, and prepend a reference line (`Re: T-YYYY-NNNN (continued)`) to the description. No native ticket-link column exists; richer linking is deferred (spec §10).
- **Migration filename:** `2026-06-13-d-ticketing-email-inbound.sql` (a/b/c taken on 2026-06-13). Bump the letter/date to the actual landing day if needed — never reuse a taken prefix.

**Worktree:** create via superpowers:using-git-worktrees from `origin/main`, branch `feat/ticketing-email-ingest`. Run `pnpm install` in fresh worktrees; **symlink the gitignored `.env.test`** (else RLS forge tests pass vacuously on a BYPASSRLS conn — see `worktree_env_test_rls_vacuous`). Prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. First commit: this plan + the spec.

---

### Task 1: Schema — `ticket_email_inbound` + `partner_inbound_domains`

**Files:**
- Create: `apps/api/src/db/schema/emailInbound.ts`
- Modify: `apps/api/src/db/schema/index.ts` (barrel export)

- [ ] **Step 1: Create the Drizzle schema file**

Create `apps/api/src/db/schema/emailInbound.ts`:

```typescript
import { pgTable, uuid, text, varchar, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { tickets } from './portal';

// Shape 3 (partner-axis). Audit trail + dead-letter/review queue for inbound mail.
export const ticketEmailInbound = pgTable('ticket_email_inbound', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerMessageId: text('provider_message_id').notNull(),
  fromAddress: text('from_address'),
  toAddress: text('to_address'),
  subject: text('subject'),
  messageId: text('message_id'),
  inReplyTo: text('in_reply_to'),
  references: text('references'),
  parseStatus: varchar('parse_status', { length: 20 }).notNull(), // matched|created|quarantined|failed|ignored
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  error: text('error'),
  raw: jsonb('raw'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('ticket_email_inbound_provider_msg_uq').on(t.partnerId, t.providerMessageId),
  index('ticket_email_inbound_review_idx').on(t.partnerId, t.parseStatus, t.createdAt)
]);

// Model-B seam (spec D5): empty in v1; the custom-domain wizard manages it later.
export const partnerInboundDomains = pgTable('partner_inbound_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  domain: varchar('domain', { length: 255 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerDomainId: text('provider_domain_id'),
  verificationStatus: varchar('verification_status', { length: 20 }).notNull().default('pending'),
  dnsRecords: jsonb('dns_records'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  verifiedAt: timestamp('verified_at')
}, (t) => [
  uniqueIndex('partner_inbound_domains_domain_uq').on(t.domain),
  index('partner_inbound_domains_partner_idx').on(t.partnerId)
]);
```

- [ ] **Step 2: Barrel export**

In `apps/api/src/db/schema/index.ts`, after `export * from './portal';` (line 20) add:

```typescript
export * from './emailInbound';
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/emailInbound.ts apps/api/src/db/schema/index.ts
git commit -m "feat(ticketing): email-inbound + partner-inbound-domains schema (Phase 4)"
```

---

### Task 2: Migration — tables, indexes, RLS, triggers

**Files:**
- Create: `apps/api/migrations/2026-06-13-d-ticketing-email-inbound.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-13-d-ticketing-email-inbound.sql` (idempotent; NO inner BEGIN/COMMIT — autoMigrate wraps each file):

```sql
-- Phase 4 (native ticketing): email-to-ticket ingest tables
-- Spec: docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md

CREATE TABLE IF NOT EXISTS ticket_email_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  provider VARCHAR(50) NOT NULL,
  provider_message_id TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  parse_status VARCHAR(20) NOT NULL,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  error TEXT,
  raw JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_inbound_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  domain VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_domain_id TEXT,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  dns_records JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_inbound_provider_msg_uq
  ON ticket_email_inbound (partner_id, provider_message_id);
CREATE INDEX IF NOT EXISTS ticket_email_inbound_review_idx
  ON ticket_email_inbound (partner_id, parse_status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS partner_inbound_domains_domain_uq
  ON partner_inbound_domains (domain);
CREATE INDEX IF NOT EXISTS partner_inbound_domains_partner_idx
  ON partner_inbound_domains (partner_id);

-- RLS: both partner-axis (Shape 3). System scope (the worker) sees all; partner
-- scope sees only its own rows. No org/portal policies (internal-only, spec §6).
ALTER TABLE ticket_email_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_email_inbound FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_email_inbound_partner_access ON ticket_email_inbound
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partner_inbound_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_inbound_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_inbound_domains_partner_access ON partner_inbound_domains
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 2: Apply migration + drift check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsx src/db/autoMigrate.ts 2>/dev/null || true
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: no drift. (Note the `references` column is a reserved word — quoted in SQL, plain in Drizzle; if drift flags it, confirm the Drizzle column name maps to `references` and re-run.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-06-13-d-ticketing-email-inbound.sql
git commit -m "feat(ticketing): email-inbound tables migration + RLS (Phase 4)"
```

---

### Task 3: RLS-coverage allowlist + functional forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (PARTNER_TENANT_TABLES)
- Create: `apps/api/src/__tests__/integration/emailInboundRls.integration.test.ts`

- [ ] **Step 1: Add allowlist entries**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, extend `PARTNER_TENANT_TABLES` (mirror the `time_entries` entry):

```typescript
  ['ticket_email_inbound', 'partner_id'],
  ['partner_inbound_domains', 'partner_id'],
```

- [ ] **Step 2: Write the functional forge test (contract test is not enough — see dual-axis blindspot)**

Create `apps/api/src/__tests__/integration/emailInboundRls.integration.test.ts`. Mirror the structure of an existing partner-axis functional RLS test (find one with `grep -l "breeze_has_partner_access\|new row violates" apps/api/src/__tests__/integration/*.test.ts`). The test, as `breeze_app` under partner A's context, must:

```typescript
// Pseudocode shape — adapt to the repo's RLS test harness (withDbAccessContext for partner A):
it('rejects a cross-partner insert into ticket_email_inbound', async () => {
  await expect(
    insertAsPartner('A', ticketEmailInbound, { partnerId: PARTNER_B_ID, provider: 'mailgun', providerMessageId: 'x', parseStatus: 'created' })
  ).rejects.toThrow(/row-level security/);
});
it('hides partner B rows from partner A selects', async () => {
  // seed a row for B under system context, then select under A → 0 rows
});
```

- [ ] **Step 3: Run the RLS coverage + forge tests (real DB)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/emailInboundRls.integration.test.ts
```

Expected: PASS. **Confirm the test role is not BYPASSRLS** (`SELECT rolbypassrls FROM pg_roles WHERE rolname='breeze_app';` → false) or the forge test passes vacuously.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/emailInboundRls.integration.test.ts
git commit -m "test(ticketing): RLS coverage + cross-partner forge for email-inbound tables"
```

---

### Task 4: Provider abstraction — types

**Files:**
- Create: `apps/api/src/services/inboundEmail/types.ts`

- [ ] **Step 1: Define the interfaces**

Create `apps/api/src/services/inboundEmail/types.ts`:

```typescript
import type { HonoRequest } from 'hono';

export interface NormalizedInboundEmail {
  provider: string;
  providerMessageId: string;
  to: string;            // recipient → partner resolution
  from: string;          // sender (untrusted)
  fromName?: string;
  subject: string;
  text: string;          // plain body
  html?: string;         // retained raw, not rendered in v1
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  autoSubmitted?: string; // for loop-prevention (used in PR3)
  precedence?: string;
  attachments: { filename: string; contentType: string; size: number }[]; // metadata only
  raw: Record<string, unknown>;
}

export interface InboundEmailProvider {
  readonly name: string;
  verify(req: HonoRequest): Promise<boolean>;
  parse(req: HonoRequest): Promise<NormalizedInboundEmail>;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/inboundEmail/types.ts
git commit -m "feat(ticketing): inbound email provider interface (Phase 4)"
```

---

### Task 5: `MailgunInboundProvider.verify` — HMAC signature

**Files:**
- Create: `apps/api/src/services/inboundEmail/mailgun.ts`
- Create: `apps/api/src/services/inboundEmail/mailgun.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/inboundEmail/mailgun.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../config/validate', () => ({ getConfig: () => ({ MAILGUN_INBOUND_SIGNING_KEY: 'test-signing-key' }) }));

import { MailgunInboundProvider } from './mailgun';

const SIGNING_KEY = 'test-signing-key';
const sign = (timestamp: string, token: string) =>
  createHmac('sha256', SIGNING_KEY).update(timestamp + token).digest('hex');

// Minimal HonoRequest stub exposing parseBody()
function reqWith(fields: Record<string, string>) {
  return { parseBody: async () => fields } as unknown as import('hono').HonoRequest;
}

describe('MailgunInboundProvider.verify', () => {
  const provider = new MailgunInboundProvider();
  it('accepts a valid signature', async () => {
    const timestamp = '1700000000', token = 'abc';
    const ok = await provider.verify(reqWith({ timestamp, token, signature: sign(timestamp, token) }));
    expect(ok).toBe(true);
  });
  it('rejects a tampered signature', async () => {
    const ok = await provider.verify(reqWith({ timestamp: '1700000000', token: 'abc', signature: 'deadbeef' }));
    expect(ok).toBe(false);
  });
  it('rejects when signing fields are absent', async () => {
    expect(await provider.verify(reqWith({}))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/mailgun.test.ts --pool=forks
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `verify`**

Create `apps/api/src/services/inboundEmail/mailgun.ts` (confirm the key: `grep -n "MAILGUN" apps/api/src/config/validate.ts`; if absent, add `MAILGUN_INBOUND_SIGNING_KEY: z.string().optional()` to the envSchema in `apps/api/src/config/validate.ts` (read via `getConfig()`)):

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HonoRequest } from 'hono';
import { getConfig } from '../../config/validate';
import type { InboundEmailProvider, NormalizedInboundEmail } from './types';

export class MailgunInboundProvider implements InboundEmailProvider {
  readonly name = 'mailgun';

  async verify(req: HonoRequest): Promise<boolean> {
    const body = (await req.parseBody()) as Record<string, string>;
    const { timestamp, token, signature } = body;
    if (!timestamp || !token || !signature) return false;
    const key = getConfig().MAILGUN_INBOUND_SIGNING_KEY;
    if (!key) return false;
    const expected = createHmac('sha256', key).update(timestamp + token).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async parse(_req: HonoRequest): Promise<NormalizedInboundEmail> {
    throw new Error('not implemented'); // Task 6
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/mailgun.test.ts --pool=forks
```

Expected: PASS (the verify tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/mailgun.ts apps/api/src/services/inboundEmail/mailgun.test.ts apps/api/src/config/validate.ts
git commit -m "feat(ticketing): Mailgun inbound HMAC verification (Phase 4)"
```

---

### Task 6: `MailgunInboundProvider.parse` — multipart → normalized

**Files:**
- Modify: `apps/api/src/services/inboundEmail/mailgun.ts`
- Modify: `apps/api/src/services/inboundEmail/mailgun.test.ts`

- [ ] **Step 1: Add the failing parse tests**

Append to `apps/api/src/services/inboundEmail/mailgun.test.ts`:

```typescript
describe('MailgunInboundProvider.parse', () => {
  const provider = new MailgunInboundProvider();
  const fields = {
    recipient: 'acme@tickets.example.com',
    sender: 'jane@customer.com',
    from: 'Jane Doe <jane@customer.com>',
    subject: 'Re: [T-2026-0001] printer down',
    'body-plain': 'It is still broken.\n> previous quoted text',
    'stripped-text': 'It is still broken.',
    'Message-Id': '<msg-2@customer.com>',
    'In-Reply-To': '<msg-1@tickets.example.com>',
    'References': '<msg-0@x> <msg-1@tickets.example.com>',
    'message-headers': '[["Auto-Submitted","no"]]'
  };
  it('maps recipient/sender/subject and prefers stripped-text', async () => {
    const n = await provider.parse({ parseBody: async () => fields } as any);
    expect(n.to).toBe('acme@tickets.example.com');
    expect(n.from).toBe('jane@customer.com');
    expect(n.fromName).toBe('Jane Doe');
    expect(n.subject).toContain('T-2026-0001');
    expect(n.text).toBe('It is still broken.'); // stripped-text wins over body-plain
    expect(n.references).toEqual(['<msg-0@x>', '<msg-1@tickets.example.com>']);
    expect(n.providerMessageId).toBe('<msg-2@customer.com>');
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`parse` throws "not implemented").

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/mailgun.test.ts --pool=forks
```

- [ ] **Step 3: Implement `parse`** (replace the stub):

```typescript
  async parse(req: HonoRequest): Promise<NormalizedInboundEmail> {
    const b = (await req.parseBody()) as Record<string, string>;
    const from = extractEmail(b.sender || b.from || '');
    const fromName = extractName(b.from || '');
    const refs = (b['References'] || '').trim();
    return {
      provider: this.name,
      providerMessageId: b['Message-Id'] || b['message-id'] || `${b.recipient}:${b.timestamp ?? ''}`,
      to: extractEmail(b.recipient || ''),
      from,
      fromName: fromName || undefined,
      subject: b.subject || '',
      text: b['stripped-text'] || b['body-plain'] || '',
      html: b['body-html'] || undefined,
      messageId: b['Message-Id'] || undefined,
      inReplyTo: b['In-Reply-To'] || undefined,
      references: refs ? refs.split(/\s+/) : undefined,
      autoSubmitted: parseHeader(b['message-headers'], 'Auto-Submitted'),
      precedence: parseHeader(b['message-headers'], 'Precedence'),
      attachments: [],
      raw: b
    };
  }
}

// `Jane Doe <jane@x.com>` → `jane@x.com`; bare address passes through.
function extractEmail(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
function extractName(s: string): string {
  const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}
function parseHeader(headersJson: string | undefined, name: string): string | undefined {
  if (!headersJson) return undefined;
  try {
    const arr = JSON.parse(headersJson) as [string, string][];
    const hit = arr.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  } catch { return undefined; }
}
```

- [ ] **Step 4: Run to verify it passes.**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/mailgun.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/mailgun.ts apps/api/src/services/inboundEmail/mailgun.test.ts
git commit -m "feat(ticketing): Mailgun inbound parse → NormalizedInboundEmail (Phase 4)"
```

---

### Task 7: `resolvePartnerByRecipient`

**Files:**
- Create: `apps/api/src/services/inboundEmail/resolvePartner.ts`
- Create: `apps/api/src/services/inboundEmail/resolvePartner.test.ts`

The resolver is the tenant-identity chokepoint (spec §4). It checks (1) `partner_inbound_domains` (empty in v1) then (2) the platform slug address `{slug}@TICKETS_INBOUND_DOMAIN`. Read-only; runs in the worker's system context.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/inboundEmail/resolvePartner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({ dbMocks: { domainRows: [] as unknown[], partnerRows: [] as unknown[] } }));
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((tbl: { _name?: string }) => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(
          // first call = domains, second = partners; switch on a marker set in the schema mock
          (tbl as any).__t === 'domains' ? dbMocks.domainRows : dbMocks.partnerRows
        )) }))
      }))
    }))
  }
}));
vi.mock('../../db/schema', () => ({
  partnerInboundDomains: { __t: 'domains', domain: 'domain', partnerId: 'partnerId' },
  partners: { __t: 'partners', slug: 'slug', id: 'id' }
}));

import { resolvePartnerByRecipient } from './resolvePartner';

beforeEach(() => { dbMocks.domainRows = []; dbMocks.partnerRows = []; });

describe('resolvePartnerByRecipient', () => {
  it('resolves via the platform slug address', async () => {
    dbMocks.partnerRows = [{ id: 'p-1' }];
    expect(await resolvePartnerByRecipient('acme@tickets.example.com')).toBe('p-1');
  });
  it('returns null for an unknown recipient domain', async () => {
    expect(await resolvePartnerByRecipient('x@notours.com')).toBeNull();
  });
  it('prefers a custom domain match (Model-B seam)', async () => {
    dbMocks.domainRows = [{ partnerId: 'p-9' }];
    expect(await resolvePartnerByRecipient('support@tickets.theirmsp.com')).toBe('p-9');
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/resolvePartner.test.ts --pool=forks
```

- [ ] **Step 3: Implement**

Create `apps/api/src/services/inboundEmail/resolvePartner.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partnerInboundDomains, partners } from '../../db/schema';
import { getConfig } from '../../config/validate';

/** Single tenant-identity chokepoint (spec §4). Read-only; caller is in system context. */
export async function resolvePartnerByRecipient(recipient: string): Promise<string | null> {
  const addr = recipient.trim().toLowerCase();
  const at = addr.indexOf('@');
  if (at < 0) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);

  // (1) Model-B custom domain (empty in v1)
  const dom = await db.select({ partnerId: partnerInboundDomains.partnerId })
    .from(partnerInboundDomains).where(eq(partnerInboundDomains.domain, domain)).limit(1);
  if (dom[0]) return dom[0].partnerId;

  // (2) platform slug address: {slug}@TICKETS_INBOUND_DOMAIN
  if (getConfig().TICKETS_INBOUND_DOMAIN && domain === getConfig().TICKETS_INBOUND_DOMAIN) {
    const p = await db.select({ id: partners.id }).from(partners).where(eq(partners.slug, local)).limit(1);
    if (p[0]) return p[0].id;
  }
  return null;
}
```

(If absent, add `TICKETS_INBOUND_DOMAIN: z.string().optional()` to the envSchema in `apps/api/src/config/validate.ts`; read via `getConfig()`.)

- [ ] **Step 4: Run to verify it passes.** Same command as Step 2 → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/resolvePartner.ts apps/api/src/services/inboundEmail/resolvePartner.test.ts apps/api/src/config/validate.ts
git commit -m "feat(ticketing): resolvePartnerByRecipient (platform slug + Model-B seam)"
```

---

### Task 8: Extend `createTicket` to carry `submitterEmail` for `source:'email'`

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (CreateTicketInput union ~line 179-182; insert ~line 260-267)
- Modify: `apps/api/src/services/ticketService.test.ts`

`createTicket` deliberately nulls `submitterEmail` for non-portal sources. Email tickets need it (outbound replies). Add an optional submitter to the email variant only — keep `alert`/`manual`/`api` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/ticketService.test.ts`:

```typescript
it('persists submitterEmail/submitterName for source:email', async () => {
  // arrange the existing createTicket mock to capture the insert values
  await createTicket(
    { orgId: 'o-1', subject: 'printer', source: 'email', submitterEmail: 'jane@x.com', submitterName: 'Jane' },
    { userId: SYSTEM_ACTOR_ID }
  );
  expect(capturedInsert.submitterEmail).toBe('jane@x.com');
  expect(capturedInsert.submitterName).toBe('Jane');
});
```

- [ ] **Step 2: Run to verify it fails** (type error / submitterEmail null).

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts -t submitterEmail --pool=forks
```

- [ ] **Step 3: Implement**

In the `CreateTicketInput` union, change the non-portal variant to split out `email`:

```typescript
export type CreateTicketInput =
  | (BaseCreateTicketInput & { source: 'portal'; submittedBy: string; submitterEmail: string; submitterName?: string })
  | (BaseCreateTicketInput & { source: 'email'; submitterEmail: string; submitterName?: string; submittedBy?: string })
  | (BaseCreateTicketInput & { source: Exclude<TicketSource, 'portal' | 'email'> });
```

In the insert (around line 266-267), make the email/portal sources carry submitter fields:

```typescript
    submittedBy: isPortal ? input.submittedBy : (input.source === 'email' ? (input.submittedBy ?? null) : null),
    submitterEmail: isPortal ? input.submitterEmail : (input.source === 'email' ? input.submitterEmail : null),
    submitterName: (isPortal || input.source === 'email') ? (input.submitterName ?? null) : (actor.name ?? null),
```

- [ ] **Step 4: Run to verify it passes** (and the full ticketService suite stays green):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(ticketing): createTicket carries submitterEmail for source:email"
```

---

### Task 9: Inbound dispatch service — log, idempotency, resolve, match, guards, dispatch

**Files:**
- Create: `apps/api/src/services/inboundEmail/inboundEmailService.ts`
- Create: `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`

This is the orchestration core. `processInboundEmail(n: NormalizedInboundEmail)` runs inside the worker's system context and:
1. resolve partner (`resolvePartnerByRecipient`) — null → log `ignored`, return.
2. idempotency — existing `(partner_id, provider_message_id)` row → return (skip).
3. thread-match within partner (In-Reply-To/References → `email_thread_key`, else `[T-YYYY-NNNN]` subject token), **re-assert matched ticket's `partner_id === partnerId`** (guard).
4. matched + status `closed` → create NEW linked ticket; matched otherwise → `appendInboundComment` + reopen `resolved`→`open`; log `matched`.
5. unmatched + known portal user (scoped to partner) → create ticket; log `created`.
6. unmatched + unknown sender → log `quarantined` (no ticket).
7. any thrown guard/error → log `failed` with the error text.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`. Mock `../../db` (capture inserts/updates keyed by table), `./resolvePartner`, `../ticketService` (`createTicket`, `changeTicketStatus`), and `../../db/schema`. Cover:

```typescript
// (sketch — implement against the file's mock harness)
describe('processInboundEmail', () => {
  it('logs ignored when the recipient resolves to no partner', async () => { /* resolve→null; expect inbound row parse_status='ignored', no ticket */ });
  it('is idempotent on duplicate provider_message_id', async () => { /* existing row → no create/append */ });
  it('appends a public comment + reopens a resolved ticket on a threaded reply', async () => {
    // thread-match returns {id:'t-1', partnerId:'p-1', status:'resolved', orgId:'o-1'}
    // expect appendInboundComment insert (is_public true, comment_type 'comment'), changeTicketStatus → 'open', parse_status='matched'
  });
  it('GUARD: refuses to touch a matched ticket from another partner', async () => {
    // thread-match returns a ticket whose partnerId !== resolved partner → throw, parse_status='failed', NO comment/update
  });
  it('creates a source:email ticket for an unmatched known portal-user sender', async () => {
    // portalUser lookup (scoped to partner) returns {id, orgId}; expect createTicket source:'email', submitterEmail set, parse_status='created'
  });
  it('quarantines an unmatched unknown sender (no ticket)', async () => {
    // portalUser lookup empty → parse_status='quarantined', createTicket NOT called
  });
  it('creates a NEW linked ticket when the matched ticket is closed', async () => {
    // matched status 'closed' → createTicket called, email_thread_key carried, parse_status='created'
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/inboundEmailService.test.ts --pool=forks
```

- [ ] **Step 3: Implement**

Create `apps/api/src/services/inboundEmail/inboundEmailService.ts`:

```typescript
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { ticketEmailInbound, tickets, ticketComments, portalUsers, organizations } from '../../db/schema';
import { createTicket, changeTicketStatus } from '../ticketService';
import { resolvePartnerByRecipient } from './resolvePartner';
import { emitTicketEvent } from '../ticketEvents';
import type { NormalizedInboundEmail } from './types';

const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Inbound Email' };
const TOKEN_RE = /\bT-(\d{4})-(\d{4,})\b/;

async function logInbound(n: NormalizedInboundEmail, partnerId: string | null, parseStatus: string, ticketId: string | null, error?: string) {
  await db.insert(ticketEmailInbound).values({
    partnerId: partnerId ?? '00000000-0000-0000-0000-000000000000', // ignored rows still need a partner_id NOT NULL; use a sentinel only when null-partner — see note
    provider: n.provider, providerMessageId: n.providerMessageId,
    fromAddress: n.from, toAddress: n.to, subject: n.subject,
    messageId: n.messageId ?? null, inReplyTo: n.inReplyTo ?? null,
    references: n.references?.join(' ') ?? null,
    parseStatus, ticketId, error: error ?? null, raw: n.raw
  });
}
```

> **Note for the implementer:** `partner_id` is `NOT NULL`, but `ignored` rows have no partner. Resolve this during Step 3 by one of: (a) make `partner_id` nullable in the migration (Task 2) and allow null for `ignored`; or (b) skip the DB log for `ignored` and only count it in metrics. **Pick (a)** — change the Task 2 column to `partner_id UUID REFERENCES partners(id)` (nullable), the Drizzle column to `.references(...)` without `.notNull()`, and the RLS policy still holds (null partner is only writable under system scope; partner-scope `breeze_has_partner_access(NULL)` is false). Update the Task 1/2/3 artifacts accordingly before finishing this task, and re-run the drift + forge tests.

Continue the implementation:

```typescript
export async function processInboundEmail(n: NormalizedInboundEmail): Promise<void> {
  const partnerId = await resolvePartnerByRecipient(n.to);
  if (!partnerId) { await logInbound(n, null, 'ignored', null); return; }

  // idempotency
  const dup = await db.select({ id: ticketEmailInbound.id }).from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.partnerId, partnerId), eq(ticketEmailInbound.providerMessageId, n.providerMessageId))).limit(1);
  if (dup[0]) return;

  try {
    const matched = await findTicketInPartner(n, partnerId);
    if (matched) {
      // GUARD (spec §6): never act across partners
      if (matched.partnerId !== partnerId) throw new Error(`cross-partner match: ticket ${matched.id}`);
      if (matched.status === 'closed') {
        const t = await createFromEmail(n, partnerId, matched.orgId, matched.emailThreadKey, matched.internalNumber);
        await logInbound(n, partnerId, 'created', t.id);
        return;
      }
      await appendInboundComment(matched.id, matched.orgId, n, partnerId);
      if (matched.status === 'resolved') {
        await changeTicketStatus(matched.id, { status: 'open' }, {}, SYSTEM_ACTOR);
      }
      await logInbound(n, partnerId, 'matched', matched.id);
      return;
    }
    // unmatched: known sender → create; unknown → quarantine
    const sender = await findPortalUserInPartner(n.from, partnerId);
    if (!sender) { await logInbound(n, partnerId, 'quarantined', null); return; }
    const t = await createFromEmail(n, partnerId, sender.orgId, null, null, sender.id);
    await logInbound(n, partnerId, 'created', t.id);
  } catch (err) {
    await logInbound(n, partnerId, 'failed', null, err instanceof Error ? err.message : String(err));
  }
}
```

Helper functions in the same file (all partner-scoped reads + the inbound-comment insert):

```typescript
interface MatchedTicket { id: string; partnerId: string | null; orgId: string; status: string; emailThreadKey: string | null; internalNumber: string | null; }

async function findTicketInPartner(n: NormalizedInboundEmail, partnerId: string): Promise<MatchedTicket | null> {
  const cols = { id: tickets.id, partnerId: tickets.partnerId, orgId: tickets.orgId, status: tickets.status, emailThreadKey: tickets.emailThreadKey, internalNumber: tickets.internalNumber };
  // 1) thread headers → email_thread_key, scoped to partner
  const key = n.inReplyTo ?? n.references?.[n.references.length - 1];
  if (key) {
    const rows = await db.select(cols).from(tickets)
      .where(and(eq(tickets.partnerId, partnerId), eq(tickets.emailThreadKey, key))).limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }
  // 2) subject token [T-YYYY-NNNN], scoped to partner (numbers are per-partner)
  const m = n.subject.match(TOKEN_RE);
  if (m) {
    const rows = await db.select(cols).from(tickets)
      .where(and(eq(tickets.partnerId, partnerId), eq(tickets.internalNumber, m[0]))).limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }
  return null;
}

async function findPortalUserInPartner(email: string, partnerId: string): Promise<{ id: string; orgId: string } | null> {
  // portal_users has no partner_id; scope via the org→partner join.
  const rows = await db.select({ id: portalUsers.id, orgId: portalUsers.orgId })
    .from(portalUsers).innerJoin(organizations, eq(portalUsers.orgId, organizations.id))
    .where(and(eq(portalUsers.email, email.toLowerCase()), eq(organizations.partnerId, partnerId))).limit(1);
  return rows[0] ?? null;
}

async function createFromEmail(n: NormalizedInboundEmail, partnerId: string, orgId: string, carryThreadKey: string | null, priorNumber: string | null, submittedBy?: string) {
  // GUARD (spec §6): the resolved org must belong to the resolved partner
  const orgOk = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId))).limit(1);
  if (!orgOk[0]) throw new Error(`org ${orgId} not in partner ${partnerId}`);

  const description = priorNumber ? `Re: ${priorNumber} (continued)\n\n${n.text}` : n.text;
  const ticket = await createTicket(
    { orgId, subject: n.subject.replace(TOKEN_RE, '').trim() || '(no subject)', description, source: 'email', submitterEmail: n.from, submitterName: n.fromName, submittedBy },
    SYSTEM_ACTOR
  );
  // stamp threading key so future replies match (carry the old key for closed-continuations)
  await db.update(tickets).set({ emailThreadKey: carryThreadKey ?? n.messageId ?? null }).where(eq(tickets.id, ticket.id));
  return ticket;
}

async function appendInboundComment(ticketId: string, orgId: string, n: NormalizedInboundEmail, partnerId: string) {
  const sender = await findPortalUserInPartner(n.from, partnerId);
  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: null,
    portalUserId: sender?.id ?? null,
    authorName: n.fromName ?? n.from,
    authorType: 'email',
    commentType: 'comment',
    content: n.text,
    isPublic: true,
    oldValue: null, newValue: null
  }).returning();
  // inbound:true → notify worker must NOT echo the email back to the sender (Task 10)
  await emitTicketEvent({ type: 'ticket.commented', ticketId, commentId: inserted[0].id, isPublic: true, inbound: true } as never);
}
```

> Confirm `ticketEvents.ts`'s `ticket.commented` payload type; add an optional `inbound?: boolean` field to it (Task 10 Step 1) so the cast `as never` can be removed.

- [ ] **Step 4: Run to verify it passes.** (Same command as Step 2 → PASS.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/inboundEmailService.ts apps/api/src/services/inboundEmail/inboundEmailService.test.ts
git commit -m "feat(ticketing): inbound email dispatch service (match/create/quarantine + guards)"
```

---

### Task 10: Queue + worker + notify-worker echo guard

**Files:**
- Create: `apps/api/src/services/inboundEmailQueue.ts`
- Create: `apps/api/src/jobs/inboundEmailWorker.ts`
- Modify: `apps/api/src/services/ticketEvents.ts` (add `inbound?: boolean` to `ticket.commented`)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (skip submitter email when `inbound`)
- Modify: `apps/api/src/index.ts` (register worker ~line 1070)
- Create: `apps/api/src/jobs/inboundEmailWorker.test.ts`

- [ ] **Step 1: Add `inbound?` to the event type + the notify-worker guard (with test)**

In `apps/api/src/services/ticketEvents.ts`, add `inbound?: boolean` to the `ticket.commented` variant. In `apps/api/src/jobs/ticketNotifyWorker.ts`, find the `ticket.commented` + `isPublic` branch that emails `submitterEmail` and guard it:

```typescript
// inbound emails must not be echoed back to the sender
if (event.type === 'ticket.commented' && event.isPublic && !event.inbound) {
  // ...existing email-to-submitter logic...
}
```

Add a notify-worker test asserting an `inbound:true` commented event does NOT call the email sender. (Extend `ticketNotifyWorker.test.ts` if it exists; otherwise assert via the email-service mock.)

- [ ] **Step 2: Implement the queue + emit**

Create `apps/api/src/services/inboundEmailQueue.ts` (mirror `ticketEvents.ts`):

```typescript
import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from '../lib/sentry';
import type { NormalizedInboundEmail } from './inboundEmail/types';

export const INBOUND_EMAIL_QUEUE = 'ticket-email-inbound';
let queue: Queue | null = null;
export function getInboundEmailQueue(): Queue {
  if (!queue) queue = new Queue(INBOUND_EMAIL_QUEUE, { connection: getBullMQConnection() });
  return queue;
}
export async function enqueueInboundEmail(n: NormalizedInboundEmail): Promise<void> {
  try {
    await getInboundEmailQueue().add('inbound', n, {
      removeOnComplete: { count: 200 }, removeOnFail: { count: 1000 },
      attempts: 3, backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[InboundEmail] enqueue failed', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw err; // the route turns this into a 503 so the provider retries
  }
}
```

- [ ] **Step 3: Implement the worker**

Create `apps/api/src/jobs/inboundEmailWorker.ts` (mirror `ticketNotifyWorker.ts`; run processing in `withSystemDbAccessContext`):

```typescript
import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { INBOUND_EMAIL_QUEUE } from '../services/inboundEmailQueue';
import { processInboundEmail } from '../services/inboundEmail/inboundEmailService';
import * as dbModule from '../db';
import type { NormalizedInboundEmail } from '../services/inboundEmail/types';

let worker: Worker<NormalizedInboundEmail> | null = null;

export function initializeInboundEmailWorker(): Promise<void> {
  if (worker) return Promise.resolve();
  worker = new Worker<NormalizedInboundEmail>(
    INBOUND_EMAIL_QUEUE,
    async (job: Job<NormalizedInboundEmail>) =>
      dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(() => processInboundEmail(job.data))),
    { connection: getBullMQConnection(), concurrency: 5 }
  );
  worker.on('failed', (job, err) => console.error('[InboundEmailWorker] job failed', job?.id, err?.message));
  worker.on('error', (err) => console.error('[InboundEmailWorker] error', err.message));
  return Promise.resolve();
}
export async function shutdownInboundEmailWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
}
```

- [ ] **Step 4: Register the worker** in `apps/api/src/index.ts` near line 1070, next to the other ticket workers:

```typescript
  ['inboundEmailWorker', initializeInboundEmailWorker],
```

(Add the import alongside the other worker imports, and the shutdown to the shutdown list if one exists.)

- [ ] **Step 5: Worker test** — `apps/api/src/jobs/inboundEmailWorker.test.ts`: mock `processInboundEmail` + `../db`, assert the worker passes `job.data` through `withSystemDbAccessContext`.

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/inboundEmailWorker.test.ts src/jobs/ticketNotifyWorker.test.ts --pool=forks
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/inboundEmailQueue.ts apps/api/src/jobs/inboundEmailWorker.ts apps/api/src/jobs/inboundEmailWorker.test.ts apps/api/src/services/ticketEvents.ts apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/index.ts
git commit -m "feat(ticketing): inbound email queue + worker + no-echo notify guard"
```

---

### Task 11: Webhook route + mount

**Files:**
- Create: `apps/api/src/routes/tickets/emailWebhook.ts`
- Modify: `apps/api/src/index.ts` (mount route)
- Create: `apps/api/src/routes/tickets/emailWebhook.test.ts`

Thin edge: rate-limit, verify HMAC, parse, enqueue, 202. No business logic. No session auth.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/tickets/emailWebhook.test.ts`. Mock the provider (`verify`/`parse`), `enqueueInboundEmail`, and `rateLimiter`. Assert:
- invalid signature → 401, no enqueue;
- valid signature → 202, `enqueueInboundEmail` called with parsed email;
- rate-limited → 429.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const { verifyMock, parseMock, enqueueMock, rlMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(), parseMock: vi.fn(), enqueueMock: vi.fn(), rlMock: vi.fn()
}));
vi.mock('../../services/inboundEmail/mailgun', () => ({ MailgunInboundProvider: class { name='mailgun'; verify=verifyMock; parse=parseMock; } }));
vi.mock('../../services/inboundEmailQueue', () => ({ enqueueInboundEmail: enqueueMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rlMock }));
// ...import the Hono app/route and exercise with app.request(...)
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/tickets/emailWebhook.ts`:

```typescript
import { Hono } from 'hono';
import { MailgunInboundProvider } from '../../services/inboundEmail/mailgun';
import { enqueueInboundEmail } from '../../services/inboundEmailQueue';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis'; // confirm the redis accessor name

export const emailWebhookRoutes = new Hono();
const provider = new MailgunInboundProvider();

emailWebhookRoutes.post('/email-inbound', async (c) => {
  const rl = await rateLimiter(getRedis(), 'inbound-email:webhook', 600, 60);
  if (!rl.allowed) return c.json({ error: 'rate_limited' }, 429);

  if (!(await provider.verify(c.req))) return c.json({ error: 'invalid_signature' }, 401);

  let normalized;
  try { normalized = await provider.parse(c.req); }
  catch { return c.json({ error: 'unparseable' }, 400); }

  try { await enqueueInboundEmail(normalized); }
  catch { return c.json({ error: 'enqueue_failed' }, 503); } // provider retries

  return c.json({ ok: true }, 202);
});
```

> `provider.verify` and `provider.parse` both call `c.req.parseBody()`; Hono caches the parsed body, so two reads are safe. If a raw-body signature scheme is later needed, mirror `routes/agents/logs.ts` (`Buffer.from(await c.req.arrayBuffer())`).

- [ ] **Step 4: Mount the route** in `apps/api/src/index.ts` (with the other webhook/ticket mounts):

```typescript
import { emailWebhookRoutes } from './routes/tickets/emailWebhook';
api.route('/webhooks/tickets', emailWebhookRoutes);
```

(Verify there is no auth middleware applied to `/webhooks/*` that would 401 the provider; this path is intentionally unauthenticated, gated by HMAC. Check how existing webhook routes — if any — are excluded from `requireAuth`.)

- [ ] **Step 5: Run to verify it passes.**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/emailWebhook.test.ts --pool=forks
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tickets/emailWebhook.ts apps/api/src/routes/tickets/emailWebhook.test.ts apps/api/src/index.ts
git commit -m "feat(ticketing): inbound email webhook route (HMAC + enqueue, Phase 4)"
```

---

### Task 12: Cross-partner isolation integration test (real driver)

**Files:**
- Create: `apps/api/src/services/inboundEmail/inboundEmail.integration.test.ts`

The unit tests use mocks; this proves the app-level guards hold against a real DB under system context (the worker's actual context).

- [ ] **Step 1: Write the test**

Seed two partners A and B (each with an org + a ticket) via system context. Then run `withSystemDbAccessContext(() => processInboundEmail(n))` with:
1. **matched path, forged cross-partner reference:** email addressed to A's slug address, subject `[T-...]` / `In-Reply-To` referencing **B's** ticket → assert B's ticket is unchanged (no new comment, status unchanged) and an A-scoped `ticket_email_inbound` row exists with `parse_status IN ('created','quarantined','failed')` (never `matched` against B).
2. **created path:** email from a known A portal user → a `source:'email'` ticket exists under A's org with `submitter_email` set; `parse_status='created'`.
3. **quarantine path:** email from an unknown sender to A → `parse_status='quarantined'`, no ticket.
4. **idempotency:** processing the same `provider_message_id` twice yields one outcome.

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/services/inboundEmail/inboundEmail.integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/inboundEmail/inboundEmail.integration.test.ts
git commit -m "test(ticketing): cross-partner inbound email isolation (real driver)"
```

---

### Task 13: Final verification + PR

- [ ] **Step 1: Typecheck + affected tests**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail src/jobs/inboundEmailWorker.test.ts src/routes/tickets/emailWebhook.test.ts src/services/ticketService.test.ts --pool=forks
```

Expected: clean typecheck; the new suites pass. (Pre-existing unrelated failures in the full suite are known — verify only the affected files; see `api_test_suite_parallel_flakiness`.)

- [ ] **Step 2: Manual cross-tenant DB check as `breeze_app`** (CLAUDE.md RLS workflow)

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- forge a cross-tenant insert; must fail:
-- INSERT INTO ticket_email_inbound(partner_id, provider, provider_message_id, parse_status) VALUES ('<other-partner>','mailgun','x','created');
-- expected: ERROR new row violates row-level security policy
```

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/ticketing-email-ingest
gh pr create --title "feat(ticketing): Phase 4 email-to-ticket ingest backend" --body "$(cat <<'EOF'
Phase 4 PR 1 — inbound half of email-to-ticket. Spec: docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md.

**What:** HMAC-verified Mailgun webhook → BullMQ worker → log/resolve/thread-match/dispatch (append comment | create source:email ticket | quarantine unknown senders). Two partner-axis tables (ticket_email_inbound, partner_inbound_domains seam) with RLS.

**Isolation (spec §6):** worker runs under system context (matches ticketSlaWorker); isolation is app-enforced via partner-scoped reads + write-boundary guards; proven by a real-driver cross-partner test.

**Out of scope (later PRs):** outbound threading + autoresponder (PR3), Settings UI + review queue (PR4), Model-B custom-domain wizard.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (for the implementer)

- **`partner_id` nullable for `ignored` rows:** the Task 9 note requires making `ticket_email_inbound.partner_id` nullable (Tasks 1/2/3). Apply that before finishing Task 9; the RLS policy is unaffected (null partner is system-write-only).
- **Config keys:** `TICKETS_INBOUND_DOMAIN` and `MAILGUN_INBOUND_SIGNING_KEY` must be added to the envSchema in `apps/api/src/config/validate.ts` (Tasks 5/7) and to deploy env (`/opt/breeze/.env` + the compose `environment:` block — see CLAUDE.md "new required env var"). They are optional (feature off when unset): the webhook should 503/parse-fail closed without the signing key.
- **`SYSTEM_ACTOR` user id:** `createTicket`/`changeTicketStatus` stamp `actor.userId` into audit/`created_by`. Confirm a real sentinel user row exists or that these columns accept the all-zero UUID; if a real system user is required, reuse whatever `source:'alert'` ticket creation uses (`grep -n "createTicket" apps/api/src/services/ticketService.ts:822` for the alert precedent) and mirror it.
- **`ticket.commented` payload:** removing the `as never` cast depends on adding `inbound?: boolean` in Task 10 Step 1 — do that first if implementing out of order.

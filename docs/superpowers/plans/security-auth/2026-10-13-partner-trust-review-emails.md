# Partner Trust Review Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email a partner's admins when they request a trust review and when the partner is promoted from probation to trusted, without any send ever failing the trust write or the request.

**Architecture:** One new service module, `partnerTrustPartnerMail.ts`, owns both Breeze-branded emails (pure template builders plus two never-throw senders) and is the only thing `partnerTrust.ts` and `routes/partnerTrust.ts` import. Recipients come from a new shared `listActivePartnerAdmins` helper that replaces three existing copies of the same query. Two platform-lane entries are added to the mail-purpose registry. The admin promote route becomes a compare-and-swap so the approval email and the audit row always describe the same transition.

**Tech Stack:** Hono, Drizzle (queries only), Vitest with `vi.hoisted` + `vi.mock` fixtures, the existing `renderLayout` / `renderButton` / `supportFooter` email helpers, `MAIL_PURPOSES` registry.

**Spec:** `docs/superpowers/specs/security-auth/2026-10-13-partner-trust-review-emails-design.md`

## Global Constraints

- Do not touch `services/emailTemplates/`. That is the partner-editable catalogue. These emails use the platform idiom from `services/emailDomains/statusMail.ts`.
- Both senders return 0 and send nothing unless `partnerTrustMode() === 'enforce'`.
- Approval email fires only when `before.trustState === 'probation'` and `next === 'trusted'`; the mail module additionally requires `partners.status === 'active'`.
- Recipients are users with `users.status = 'active'` holding the `Partner Admin` role (plus the requester for the review-received email).
- The review-received copy contains no turnaround figure, no description of what is reviewed, and no promise of an outcome. Exact copy is in spec §4.7 and reproduced in Task 2.
- Senders never throw. Every failure path logs with the `[PartnerTrust]` prefix, calls `captureException`, and returns 0.
- Recipient and partner lookups run inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`. The transport call happens after that callback has resolved.
- Purposes are `account.trust_review_received` and `account.trust_approved`, both `{ lane: 'platform' }`. Every new purpose needs a row in `mailPurposes.test.ts`, a row in `email.golden.test.ts`, and a string-literal send site (checked by `mailPurposes.callSites.test.ts`).
- No migration, no schema change, no new env var, no backfill, no web code change.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Scoped test runs use `cd apps/api && npx vitest run <substring>`; never `pnpm --filter <pkg> test -- --run <path>` (see `docs/agents/testing.md`).

## Review Focus

1. A partner whose admin is the requester but holds a custom role (not `Partner Admin`): the requester must still receive the review-received email. Pinned in Task 2 ("includes the requester even when no Partner Admin exists").
2. A partner with no active Partner Admin at promotion time: `setTrustState` must still return `true` and audit; the sender returns 0. Pinned in Task 2 ("returns 0 when there are no recipients") and Task 4 ("send rejects: still resolves true").
3. A partner name containing HTML (`Acme <b>MSP</b>`): must be escaped in the HTML part and left raw in the text part. Pinned in Task 2 (both template tests).
4. Self-hosted install (`IS_HOSTED` unset, mode resolves to `off`) reaching `setTrustState` through any path: no email, no DB lookup. Pinned in Task 2 ("mode gate runs before any lookup").
5. Admin promotes a partner the queue showed as probation, but an auto-promotion landed first: the route must return 409 and send nothing, rather than emailing twice. Pinned in Task 5 ("409 when the CAS loses").

---

### Task 1: Shared `listActivePartnerAdmins` helper

**Files:**
- Create: `apps/api/src/services/partnerAdminRecipients.ts`
- Create: `apps/api/src/services/partnerAdminRecipients.test.ts`

**Interfaces:**
- Consumes: `db`, `runOutsideDbContext`, `withSystemDbAccessContext` from `../db`; `partnerUsers`, `roles`, `users` from `../db/schema`.
- Produces: `listActivePartnerAdmins(partnerId: string): Promise<PartnerAdminRecipient[]>` where `PartnerAdminRecipient = { id: string; email: string; name: string | null }`. Emails are trimmed, rows with an empty email dropped, and rows deduplicated by trimmed email (the same `new Set(emails)` semantics the three existing sites use today; the existing suites mock rows with only an `email` field, so dedupe must not key on `id`). Tasks 2 and 6 call this.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/partnerAdminRecipients.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/emailDomains/statusMail.test.ts pattern).
const { dbResults, contextLog } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  contextLog: [] as string[],
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => { contextLog.push('outside'); return fn(); },
    withSystemDbAccessContext: (fn: () => unknown) => { contextLog.push('system'); return fn(); },
    getCurrentDbAccessContext: () => undefined,
  };
});

import { listActivePartnerAdmins } from './partnerAdminRecipients';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  contextLog.length = 0;
});

describe('listActivePartnerAdmins', () => {
  it('returns id, trimmed email and name for every row, dropping empty emails and duplicate emails', async () => {
    dbResults.push([
      { id: 'u1', email: ' admin@acme.test ', name: 'Ada' },
      { id: 'u2', email: '', name: 'Nobody' },
      { id: 'u1-dup', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u3', email: 'ops@acme.test', name: null },
    ]);

    const admins = await listActivePartnerAdmins(PARTNER_ID);

    expect(admins).toEqual([
      { id: 'u1', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u3', email: 'ops@acme.test', name: null },
    ]);
  });

  it('runs outside any request context and then in system scope', async () => {
    dbResults.push([]);
    await listActivePartnerAdmins(PARTNER_ID);
    expect(contextLog).toEqual(['outside', 'system']);
  });

  it('returns an empty list when the partner has no active Partner Admin', async () => {
    dbResults.push([]);
    await expect(listActivePartnerAdmins(PARTNER_ID)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run partnerAdminRecipients`
Expected: FAIL — `Failed to resolve import "./partnerAdminRecipients"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/partnerAdminRecipients.ts
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerUsers, roles, users } from '../db/schema';

export interface PartnerAdminRecipient {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The partner's active users holding the `Partner Admin` role — the people
 * Breeze notifies about account-level events (sending-domain status, account
 * deletion, archive purge warnings, trust review).
 *
 * `partner_users` / `users` are partner-axis tables, and callers range from
 * request handlers (where an org- or partner-scoped context is already
 * active) to workers (no context at all). Step outside any ambient context
 * first, then run in system scope; `withSystemDbAccessContext` alone
 * short-circuits when a context already exists and the query would silently
 * run as the caller.
 */
export async function listActivePartnerAdmins(partnerId: string): Promise<PartnerAdminRecipient[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
    .where(and(
      eq(partnerUsers.partnerId, partnerId),
      eq(roles.name, 'Partner Admin'),
      eq(users.status, 'active'),
    )), 'partnerAdminRecipients.list'));

  // Dedupe by address, not by id: that is what every existing site did with
  // `new Set(emails)`, and it is what their tests (which mock rows carrying
  // only `email`) continue to assert.
  const seen = new Set<string>();
  const out: PartnerAdminRecipient[] = [];
  for (const row of rows) {
    const email = row.email?.trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ id: row.id, email, name: row.name ?? null });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run partnerAdminRecipients`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/partnerAdminRecipients.ts apps/api/src/services/partnerAdminRecipients.test.ts
git commit -m "feat(api): shared listActivePartnerAdmins recipient helper (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Mail purposes + `partnerTrustPartnerMail` module

**Files:**
- Modify: `apps/api/src/services/emailDomains/mailPurposes.ts` (the `account.*` block, after `'account.purge_warning'`)
- Modify: `apps/api/src/services/emailDomains/mailPurposes.test.ts` (the pinned map in `pins the §8.2 classification of every purpose`)
- Modify: `apps/api/src/services/email.golden.test.ts` (the `GOLDEN` array)
- Create: `apps/api/src/services/partnerTrustPartnerMail.ts`
- Create: `apps/api/src/services/partnerTrustPartnerMail.test.ts`

**Interfaces:**
- Consumes: `listActivePartnerAdmins` (Task 1); `getEmailService`, `BODY_PARA`, `MUTED_PARA`, `supportFooter`, `EmailTemplate` from `./email`; `escapeHtml`, `renderButton`, `renderLayout` from `./emailLayout`; `partnerTrustMode` from `../config/partnerTrustMode`; `captureException` from `./sentry`.
- Produces:
  - `buildTrustReviewReceivedTemplate(input: { partnerName: string; meetingUrl: string | null }): EmailTemplate`
  - `buildTrustApprovedTemplate(input: { partnerName: string; appUrl: string | null; docsUrl?: string }): EmailTemplate`
  - `sendTrustReviewReceivedEmail(input: { partnerId: string; requestedByUserId: string }): Promise<number>`
  - `sendTrustApprovedEmail(input: { partnerId: string }): Promise<number>`
  - `GETTING_STARTED_DOCS_URL = 'https://docs.breezermm.com/getting-started/quickstart/'`
  - Tasks 3 and 4 call the two senders.

- [ ] **Step 1: Add the two purposes to the registry tests first**

In `apps/api/src/services/emailDomains/mailPurposes.test.ts`, inside the `toEqual({...})` map, after the `'account.purge_warning': { lane: 'platform' },` line add:

```ts
      'account.trust_review_received': { lane: 'platform' },
      'account.trust_approved': { lane: 'platform' },
```

In `apps/api/src/services/email.golden.test.ts`, in the `GOLDEN` array after the `account.purge_warning` row add:

```ts
  { name: 'account.trust_review_received', params: { ...MESSAGE, purpose: 'account.trust_review_received' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.trust_approved', params: { ...MESSAGE, purpose: 'account.trust_approved' }, expectedFrom: DEFAULT_FROM },
```

- [ ] **Step 2: Run the registry tests to verify they fail**

Run: `cd apps/api && npx vitest run mailPurposes.test email.golden`
Expected: FAIL — the pinned-map `toEqual` reports the two missing keys, and the golden coverage test reports purposes not in the registry. (The `email.golden` rows will not typecheck until Step 3 either; vitest still runs them.)

- [ ] **Step 3: Add the registry entries**

In `apps/api/src/services/emailDomains/mailPurposes.ts`, after the `'account.purge_warning': { lane: 'platform' },` line:

```ts
  // #8713. Breeze → the partner's own admins about the partner's trust
  // review: the request was received, or the partner is now trusted. Platform
  // lane: account mail to the partner's staff must not depend on, or appear to
  // come from, a partner sending domain. Send site:
  // services/partnerTrustPartnerMail.ts.
  'account.trust_review_received': { lane: 'platform' },
  'account.trust_approved': { lane: 'platform' },
```

- [ ] **Step 4: Run the registry tests to verify they pass, and note the call-site test is red until Step 7**

Run: `cd apps/api && npx vitest run mailPurposes.test email.golden`
Expected: PASS.

Run: `cd apps/api && npx vitest run mailPurposes.callSites`
Expected: FAIL — `has no dead registry entries` lists both new purposes. This goes green once the send sites in Step 7 exist. Do not commit between here and Step 8.

- [ ] **Step 5: Write the failing module tests**

```ts
// apps/api/src/services/partnerTrustPartnerMail.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/emailDomains/statusMail.test.ts pattern).
// `inSystemContext` lets a test assert the transport call happens after the
// system-scope callback has resolved (#1105: no pooled connection held across
// the SMTP round trip).
const { dbResults, ctx } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  ctx: { inSystemContext: false, sendCalledInsideContext: null as boolean | null },
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => {
      ctx.inSystemContext = true;
      try { return await fn(); } finally { ctx.inSystemContext = false; }
    },
    getCurrentDbAccessContext: () => undefined,
  };
});

const { sendEmailMock, getEmailServiceMock, listActivePartnerAdmins, partnerTrustMode, captureException } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
  listActivePartnerAdmins: vi.fn(),
  partnerTrustMode: vi.fn(() => 'enforce' as 'off' | 'shadow' | 'enforce'),
  captureException: vi.fn(),
}));
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});
vi.mock('./partnerAdminRecipients', () => ({ listActivePartnerAdmins }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode }));
vi.mock('./sentry', () => ({ captureException }));

import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import {
  buildTrustApprovedTemplate,
  buildTrustReviewReceivedTemplate,
  GETTING_STARTED_DOCS_URL,
  sendTrustApprovedEmail,
  sendTrustReviewReceivedEmail,
} from './partnerTrustPartnerMail';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_PARTNER = { name: 'Acme MSP', status: 'active' };

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  ctx.inSystemContext = false;
  ctx.sendCalledInsideContext = null;
  process.env = { ...originalEnv };
  delete process.env.PARTNER_MEETING_URL;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.DASHBOARD_URL;
  partnerTrustMode.mockReturnValue('enforce');
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockImplementation(async () => {
    ctx.sendCalledInsideContext = ctx.inSystemContext;
  });
  listActivePartnerAdmins.mockResolvedValue([
    { id: 'u-admin', email: 'admin@acme.test', name: 'Ada' },
  ]);
});

describe('registry entries', () => {
  it('both trust purposes are PLATFORM lane', () => {
    expect(MAIL_PURPOSES['account.trust_review_received']).toEqual({ lane: 'platform' });
    expect(MAIL_PURPOSES['account.trust_approved']).toEqual({ lane: 'platform' });
  });
});

describe('buildTrustReviewReceivedTemplate', () => {
  it('confirms receipt, promises only a follow-up email, and escapes the partner name', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme <b>MSP</b>', meetingUrl: null });
    expect(tpl.subject).toBe('We received your review request');
    expect(tpl.html).toContain('Review request received');
    expect(tpl.html).toContain('Acme &lt;b&gt;MSP&lt;/b&gt;');
    expect(tpl.html).not.toContain('<b>MSP</b>');
    expect(tpl.text).toContain('Acme <b>MSP</b>');
    expect(tpl.text).toContain("We'll follow up by email");
    expect(tpl.html).not.toContain('Book a call');
  });

  it('states no turnaround figure and describes nothing that is reviewed', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme MSP', meetingUrl: null });
    const prose = `${tpl.subject}\n${tpl.text}`;
    expect(prose).not.toMatch(/\d+\s*(hour|day|business day)/i);
    expect(prose).not.toMatch(/within/i);
    for (const banned of ['card', 'IP', 'device', 'signal', 'approve', 'approval']) {
      expect(prose).not.toMatch(new RegExp(`\\b${banned}`, 'i'));
    }
  });

  it('offers a Book a call button only when a meeting URL is supplied', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme MSP', meetingUrl: 'https://meet.example.test/trust' });
    expect(tpl.html).toContain('Book a call');
    expect(tpl.html).toContain('https://meet.example.test/trust');
    expect(tpl.text).toContain('Book a call: https://meet.example.test/trust');
  });
});

describe('buildTrustApprovedTemplate', () => {
  it('announces the approval, lists remote control and script execution, and links the docs', () => {
    const tpl = buildTrustApprovedTemplate({ partnerName: 'Acme <MSP>', appUrl: null });
    expect(tpl.subject).toBe('Your Breeze account is approved');
    expect(tpl.html).toContain('Account approved');
    expect(tpl.html).toContain('Acme &lt;MSP&gt;');
    expect(tpl.text).toContain('Remote control and script execution are now enabled');
    expect(tpl.text).toContain(GETTING_STARTED_DOCS_URL);
    expect(tpl.html).toContain(`href="${GETTING_STARTED_DOCS_URL}"`);
    expect(tpl.html).not.toContain('Open Breeze');
  });

  it('adds an Open Breeze button when an app URL is supplied', () => {
    const tpl = buildTrustApprovedTemplate({ partnerName: 'Acme MSP', appUrl: 'https://app.example.test' });
    expect(tpl.html).toContain('Open Breeze');
    expect(tpl.html).toContain('href="https://app.example.test"');
    expect(tpl.text).toContain('Open Breeze: https://app.example.test');
  });
});

describe('sendTrustReviewReceivedEmail', () => {
  it('emails the requester plus every active Partner Admin, deduplicated, with the platform purpose', async () => {
    dbResults.push([ACTIVE_PARTNER]);                                  // partner lookup
    dbResults.push([{ email: 'admin@acme.test' }]);                    // requester lookup (same address as an admin)
    listActivePartnerAdmins.mockResolvedValue([
      { id: 'u-admin', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u-ops', email: 'ops@acme.test', name: null },
    ]);

    const sent = await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });

    expect(sent).toBe(2);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('account.trust_review_received');
    expect(envelope.to).toEqual(['admin@acme.test', 'ops@acme.test']);
    expect(envelope.subject).toBe('We received your review request');
    expect(listActivePartnerAdmins).toHaveBeenCalledWith(PARTNER_ID);
  });

  it('includes the requester even when no Partner Admin exists', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);
    listActivePartnerAdmins.mockResolvedValue([]);

    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toEqual(['owner@acme.test']);
  });

  it('passes PARTNER_MEETING_URL into the template', async () => {
    process.env.PARTNER_MEETING_URL = 'https://meet.example.test/trust';
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);

    await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });

    expect(sendEmailMock.mock.calls[0]![0].html).toContain('https://meet.example.test/trust');
  });

  it('returns 0 and sends nothing when the partner is not active', async () => {
    dbResults.push([{ name: 'Acme MSP', status: 'suspended' }]);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('calls the transport only after the system-scope callback has resolved', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);
    await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });
    expect(ctx.sendCalledInsideContext).toBe(false);
  });
});

describe('sendTrustApprovedEmail', () => {
  it('emails every active Partner Admin with the approval purpose and the app button', async () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.test/';
    dbResults.push([ACTIVE_PARTNER]);

    const sent = await sendTrustApprovedEmail({ partnerId: PARTNER_ID });

    expect(sent).toBe(1);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('account.trust_approved');
    expect(envelope.to).toEqual(['admin@acme.test']);
    expect(envelope.html).toContain('href="https://app.example.test"');
  });

  it('falls back to DASHBOARD_URL for the button and omits it when neither is set', async () => {
    process.env.DASHBOARD_URL = 'https://dash.example.test';
    dbResults.push([ACTIVE_PARTNER]);
    await sendTrustApprovedEmail({ partnerId: PARTNER_ID });
    expect(sendEmailMock.mock.calls[0]![0].html).toContain('href="https://dash.example.test"');

    sendEmailMock.mockClear();
    delete process.env.DASHBOARD_URL;
    dbResults.push([ACTIVE_PARTNER]);
    await sendTrustApprovedEmail({ partnerId: PARTNER_ID });
    expect(sendEmailMock.mock.calls[0]![0].html).not.toContain('Open Breeze');
  });

  it('returns 0 when there are no recipients', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    listActivePartnerAdmins.mockResolvedValue([]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 0 and sends nothing when the partner is not active', async () => {
    dbResults.push([{ name: 'Acme MSP', status: 'suspended' }]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 0 when the partner row is missing', async () => {
    dbResults.push([]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('gates shared by both senders', () => {
  it.each(['off', 'shadow'] as const)('mode gate runs before any lookup when mode is %s', async (mode) => {
    partnerTrustMode.mockReturnValue(mode);
    dbResults.push([ACTIVE_PARTNER]); // would be consumed by the partner lookup if the gate ran late
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(dbResults).toHaveLength(1); // the queued row was never consumed: no DB lookup happened
  });

  it('is inert when email is not configured', async () => {
    getEmailServiceMock.mockReturnValue(null);
    dbResults.push([ACTIVE_PARTNER]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(dbResults).toHaveLength(1);
  });

  it('swallows a transport failure, logs it, and reports it to Sentry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbResults.push([ACTIVE_PARTNER]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));

    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[PartnerTrust]'), 'smtp down');
    error.mockRestore();
  });

  it('swallows a recipient lookup failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbResults.push([ACTIVE_PARTNER]);
    listActivePartnerAdmins.mockRejectedValueOnce(new Error('db gone'));
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
```

- [ ] **Step 6: Run the module tests to verify they fail**

Run: `cd apps/api && npx vitest run partnerTrustPartnerMail`
Expected: FAIL — `Failed to resolve import "./partnerTrustPartnerMail"`.

- [ ] **Step 7: Write the module**

```ts
// apps/api/src/services/partnerTrustPartnerMail.ts
import { and, eq } from 'drizzle-orm';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners, users } from '../db/schema';
import { BODY_PARA, MUTED_PARA, getEmailService, supportFooter, type EmailTemplate } from './email';
import { escapeHtml, renderButton, renderLayout } from './emailLayout';
import { listActivePartnerAdmins } from './partnerAdminRecipients';
import { captureException } from './sentry';

/**
 * Breeze → partner admins, about the partner's own trust review (#8713).
 *
 * Same idiom as services/emailDomains/statusMail.ts: compute subject /
 * preheader / body, run every interpolated value through `escapeHtml`, build
 * the HTML through the shared `renderLayout` shell, assemble the text arm from
 * a line list. Breeze-branded and on the platform lane — this goes TO the MSP,
 * not to their customer, and must never be partner-editable (so it does not
 * live in services/emailTemplates/).
 *
 * Partner-facing trust mail is exactly these two notices. Both senders are
 * inert unless PARTNER_TRUST_MODE is `enforce`, and both NEVER throw: they run
 * after a trust write or an accepted request has already landed, and a
 * bounced notice must not undo either.
 */

export const GETTING_STARTED_DOCS_URL = 'https://docs.breezermm.com/getting-started/quickstart/';

const WHY_REVIEW = "You're receiving this because you requested the review or administer this Breeze account.";
const WHY_APPROVED = "You're receiving this because you administer this Breeze account.";

export function buildTrustReviewReceivedTemplate(input: { partnerName: string; meetingUrl: string | null }): EmailTemplate {
  const subject = 'We received your review request';
  const heading = 'Review request received';
  const preheader = "We'll follow up by email.";
  const lead = `We received your request to review ${input.partnerName}. We'll follow up by email once the review is complete.`;
  const meanwhile = 'You can keep using Breeze in the meantime. Remote control and script execution stay paused while the review is open.';

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      <p style="${BODY_PARA}">${escapeHtml(meanwhile)}</p>
      ${input.meetingUrl ? renderButton('Book a call', input.meetingUrl) : ''}
      <p style="${MUTED_PARA}">${escapeHtml(WHY_REVIEW)}</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading,
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });
  const text = [
    lead,
    meanwhile,
    input.meetingUrl ? `Book a call: ${input.meetingUrl}` : null,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

export function buildTrustApprovedTemplate(input: { partnerName: string; appUrl: string | null; docsUrl?: string }): EmailTemplate {
  const docsUrl = input.docsUrl ?? GETTING_STARTED_DOCS_URL;
  const subject = 'Your Breeze account is approved';
  const heading = 'Account approved';
  const preheader = 'Remote control and script execution are now enabled.';
  const lead = `${input.partnerName} has been reviewed and approved.`;
  // Mirrors GatedCapability in user words. Update this sentence when a
  // capability is added to the gate; there is no generated list.
  const enabled = 'Remote control and script execution are now enabled. The probation limits on agent enrollment, installer links and custom sending domains are lifted.';
  const docs = 'New to Breeze? Start with the getting-started guide:';

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(lead)}</p>
      <p style="${BODY_PARA}">${escapeHtml(enabled)}</p>
      ${input.appUrl ? renderButton('Open Breeze', input.appUrl) : ''}
      <p style="${BODY_PARA}">${escapeHtml(docs)} <a href="${escapeHtml(docsUrl)}">${escapeHtml(docsUrl)}</a></p>
      <p style="${MUTED_PARA}">${escapeHtml(WHY_APPROVED)}</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading,
    body,
    footer: supportFooter(undefined, 'Need help? Contact'),
  });
  const text = [
    lead,
    enabled,
    input.appUrl ? `Open Breeze: ${input.appUrl}` : null,
    `${docs} ${docsUrl}`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

// Same PUBLIC_APP_URL / DASHBOARD_URL precedence as the other web-app deep
// links (services/quoteOutcomeNotify.ts, partnerTrustEvidenceCard.ts). The
// button is optional, so an unset value is `null`, never a throw.
function appBaseUrl(): string | null {
  const value = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').trim();
  return value ? value.replace(/\/+$/, '') : null;
}

function meetingUrl(): string | null {
  const value = process.env.PARTNER_MEETING_URL?.trim();
  return value || null;
}

interface MailContext {
  partnerName: string;
  requesterEmail: string | null;
}

/**
 * One system-scope round trip for the partner row (name + status) and, when
 * asked, the requester's address. Returns null unless the partner exists and
 * is `active`. Runs outside any ambient request context first: `setTrustState`
 * is reached from admin request handlers as well as from the worker, and
 * `withSystemDbAccessContext` alone short-circuits when a context already
 * exists (see partnerTrustEvidenceCard.buildEvidenceCard).
 */
async function loadMailContext(partnerId: string, requestedByUserId?: string): Promise<MailContext | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ name: partners.name, status: partners.status })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    if (!partner || partner.status !== 'active') return null;

    let requesterEmail: string | null = null;
    if (requestedByUserId) {
      const [requester] = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, requestedByUserId), eq(users.status, 'active')))
        .limit(1);
      requesterEmail = requester?.email?.trim() || null;
    }
    return { partnerName: partner.name, requesterEmail };
  }, 'partnerTrustPartnerMail.context'));
}

function dedupe(addresses: Array<string | null>): string[] {
  return [...new Set(addresses.filter((a): a is string => Boolean(a)))];
}

function reportFailure(which: string, err: unknown): 0 {
  console.error(`[PartnerTrust] ${which} email failed:`, err instanceof Error ? err.message : err);
  captureException(err instanceof Error ? err : new Error(String(err)));
  return 0;
}

/** Returns the number of addresses it went to; 0 when skipped or failed. Never throws. */
export async function sendTrustReviewReceivedEmail(input: { partnerId: string; requestedByUserId: string }): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  if (partnerTrustMode() !== 'enforce') return 0;
  try {
    const context = await loadMailContext(input.partnerId, input.requestedByUserId);
    if (!context) return 0;
    const admins = await listActivePartnerAdmins(input.partnerId);
    const to = dedupe([context.requesterEmail, ...admins.map((admin) => admin.email)]);
    if (to.length === 0) return 0;
    const template = buildTrustReviewReceivedTemplate({ partnerName: context.partnerName, meetingUrl: meetingUrl() });
    // Every DB context above has closed; the transport round trip holds no
    // pooled connection (#1105).
    await email.sendEmail({
      to,
      purpose: 'account.trust_review_received',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    return reportFailure('review-received', err);
  }
}

/** Returns the number of addresses it went to; 0 when skipped or failed. Never throws. */
export async function sendTrustApprovedEmail(input: { partnerId: string }): Promise<number> {
  const email = getEmailService();
  if (!email) return 0;
  if (partnerTrustMode() !== 'enforce') return 0;
  try {
    const context = await loadMailContext(input.partnerId);
    if (!context) return 0;
    const admins = await listActivePartnerAdmins(input.partnerId);
    const to = dedupe(admins.map((admin) => admin.email));
    if (to.length === 0) return 0;
    const template = buildTrustApprovedTemplate({ partnerName: context.partnerName, appUrl: appBaseUrl() });
    await email.sendEmail({
      to,
      purpose: 'account.trust_approved',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return to.length;
  } catch (err) {
    return reportFailure('approved', err);
  }
}
```

- [ ] **Step 8: Run the module, registry and call-site tests to verify they pass**

Run: `cd apps/api && npx vitest run partnerTrustPartnerMail mailPurposes email.golden`
Expected: PASS. `mailPurposes.callSites` is now green because both purpose literals appear in `partnerTrustPartnerMail.ts`.

If the "swallows a transport failure" test fails on the `console.error` arguments, check that `reportFailure` passes the message as the second argument (not interpolated into the first string).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/partnerTrustPartnerMail.ts apps/api/src/services/partnerTrustPartnerMail.test.ts \
  apps/api/src/services/emailDomains/mailPurposes.ts apps/api/src/services/emailDomains/mailPurposes.test.ts \
  apps/api/src/services/email.golden.test.ts
git commit -m "feat(api): partner-facing trust review emails and their mail purposes (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Send review-received from the request-review route

**Files:**
- Modify: `apps/api/src/routes/partnerTrust.ts` (imports; the `post('/request-review')` handler after the evidence-card `try/catch`)
- Modify: `apps/api/src/routes/partnerTrust.test.ts` (mocks block; `describe('partner trust routes')`)

**Interfaces:**
- Consumes: `sendTrustReviewReceivedEmail({ partnerId, requestedByUserId })` from Task 2.
- Produces: nothing new. Route response is unchanged.

- [ ] **Step 1: Add the mock and the failing tests**

In `apps/api/src/routes/partnerTrust.test.ts`, directly after the existing `vi.mock('../services/partnerTrustEvidenceCard', …)` block add:

```ts
vi.mock('../services/partnerTrustPartnerMail', () => ({
  sendTrustReviewReceivedEmail: vi.fn(async () => 1),
}));
```

After the existing `import { sendEvidenceCard } from '../services/partnerTrustEvidenceCard';` add:

```ts
import { sendTrustReviewReceivedEmail } from '../services/partnerTrustPartnerMail';
```

Inside `describe('partner trust routes', …)`, after the test `'still returns 200 when sending the evidence card throws (best-effort)'`, add:

```ts
  it('emails the partner that the review request was received, once, with the requester id', async () => {
    const response = await buildApp().request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(sendTrustReviewReceivedEmail).toHaveBeenCalledTimes(1);
    expect(sendTrustReviewReceivedEmail).toHaveBeenCalledWith({
      partnerId: auth.partnerId,
      requestedByUserId: auth.user.id,
    });
    // After the audit row: the email confirms a request that is already recorded.
    expect(vi.mocked(createAuditLog).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(sendTrustReviewReceivedEmail).mock.invocationCallOrder[0]!);
  });

  it('still returns 200 when the partner email rejects (the sender never throws, but the route must not depend on that)', async () => {
    vi.mocked(sendTrustReviewReceivedEmail).mockRejectedValueOnce(new Error('smtp down'));

    const response = await buildApp().request('/partner/trust/request-review', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requested: true });
  });
```

In the existing test `'returns 429 when a review was requested within 24 hours'` add one assertion after `expect(sendEvidenceCard).not.toHaveBeenCalled();`:

```ts
    expect(sendTrustReviewReceivedEmail).not.toHaveBeenCalled();
```

In the existing test `'rejects POST /request-review for a partner viewer without partner-wide manage access (403)'` add after `expect(sendEvidenceCard).not.toHaveBeenCalled();`:

```ts
    expect(sendTrustReviewReceivedEmail).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the route tests to verify the new ones fail**

Run: `cd apps/api && npx vitest run routes/partnerTrust`
Expected: FAIL — `emails the partner that the review request was received` reports 0 calls. The 429 and 403 assertions pass already.

- [ ] **Step 3: Wire the send into the route**

In `apps/api/src/routes/partnerTrust.ts`, add to the imports:

```ts
import { sendTrustReviewReceivedEmail } from '../services/partnerTrustPartnerMail';
```

Replace the end of the `post('/request-review')` handler, from the evidence-card `try` through `return c.json({ requested: true });`, with:

```ts
  try {
    await sendEvidenceCard(partnerId, 'review_requested');
  } catch (error) {
    // Best-effort: the review request itself already succeeded (audit row
    // written above) — a notification failure must never fail the request.
    console.warn('[PartnerTrust] Failed to send evidence card for review request', {
      partnerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Partner-facing confirmation (#8713). Sits after the UPDATE … RETURNING
  // and the audit row, so it fires once per accepted request and never on
  // the 24h-cooldown 429 above. The sender never throws; the guard below is
  // belt-and-braces so this route's contract does not depend on that.
  try {
    await sendTrustReviewReceivedEmail({ partnerId, requestedByUserId: auth.user.id });
  } catch (error) {
    console.warn('[PartnerTrust] Failed to send review-received email', {
      partnerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return c.json({ requested: true });
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `cd apps/api && npx vitest run routes/partnerTrust`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/partnerTrust.ts apps/api/src/routes/partnerTrust.test.ts
git commit -m "feat(api): confirm trust review requests to the partner by email (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Send approved from `setTrustState`

**Files:**
- Modify: `apps/api/src/services/partnerTrust.ts` (imports; `setTrustState` after `createAuditLog`)
- Modify: `apps/api/src/services/partnerTrust.test.ts` (hoisted mocks; `describe('setTrustState')`)

**Interfaces:**
- Consumes: `sendTrustApprovedEmail({ partnerId })` from Task 2; `before` (the `readTrust` row) already loaded at the top of `setTrustState`.
- Produces: no signature change. `setTrustState` still returns `Promise<boolean>`.

- [ ] **Step 1: Add the mock and the failing tests**

In `apps/api/src/services/partnerTrust.test.ts`, extend the `vi.hoisted` block: add `sendTrustApprovedEmail: vi.fn(async () => 1),` to the returned object, and destructure it:

```ts
const { audit, publish, state, tryAutoPromote, dbUpdateChain, sendTrustApprovedEmail } = vi.hoisted(() => {
  // … existing chain …
  return {
    audit: vi.fn(async () => {}),
    publish: vi.fn(async () => 1),
    state: { /* unchanged */ },
    tryAutoPromote: vi.fn(async () => false),
    dbUpdateChain: chain,
    sendTrustApprovedEmail: vi.fn(async () => 1),
  };
});
```

After `vi.mock('./partnerTrustPromotion', () => ({ tryAutoPromote }));` add:

```ts
vi.mock('./partnerTrustPartnerMail', () => ({ sendTrustApprovedEmail }));
```

Inside `describe('setTrustState', …)`, after the existing three tests, add:

```ts
  it('emails the partner once on probation → trusted, after the audit row', async () => {
    state.trustState = 'probation';

    await setTrustState('p1', 'trusted', 'admin:promote', 'user-1');

    expect(sendTrustApprovedEmail).toHaveBeenCalledTimes(1);
    expect(sendTrustApprovedEmail).toHaveBeenCalledWith({ partnerId: 'p1' });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(sendTrustApprovedEmail.mock.invocationCallOrder[0]!);
  });

  it('emails the partner on the auto-promotion CAS path too', async () => {
    state.trustState = 'probation';

    await setTrustState('p1', 'trusted', 'auto:settled_card_24h', null, {}, { expectedFrom: 'probation' });

    expect(sendTrustApprovedEmail).toHaveBeenCalledWith({ partnerId: 'p1' });
  });

  it('does not email when the CAS loses', async () => {
    state.trustState = 'probation';
    vi.mocked(writeTrust).mockResolvedValueOnce(0);

    await setTrustState('p1', 'trusted', 'auto:settled_card_24h', null, {}, { expectedFrom: 'probation' });

    expect(sendTrustApprovedEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['restricted', 'trusted'],
    ['trusted', 'trusted'],
    ['probation', 'restricted'],
    ['probation', 'probation'],
    ['trusted', 'probation'],
  ] as const)('does not email on %s → %s', async (from, to) => {
    state.trustState = from;

    const result = await setTrustState('p1', to, 'admin:change', 'user-1');

    expect(result).toBe(true);
    expect(sendTrustApprovedEmail).not.toHaveBeenCalled();
  });

  it('still resolves true and keeps the audit row when the send rejects', async () => {
    state.trustState = 'probation';
    sendTrustApprovedEmail.mockRejectedValueOnce(new Error('smtp down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(setTrustState('p1', 'trusted', 'admin:promote', 'user-1')).resolves.toBe(true);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[partnerTrust]'), expect.anything());
    warn.mockRestore();
  });
```

The file's top-level `beforeEach` (around line 174) clears each hoisted mock by hand rather than calling `vi.clearAllMocks()`, and already resets `state.trustState = 'probation'`. Add one line to it, next to `tryAutoPromote.mockClear();`:

```ts
  sendTrustApprovedEmail.mockClear();
```

Without it, call counts leak between tests and the `does not email` cases fail on the test before them.

- [ ] **Step 2: Run the service tests to verify the new ones fail**

Run: `cd apps/api && npx vitest run services/partnerTrust.test`
Expected: FAIL — the probation → trusted cases report 0 calls to `sendTrustApprovedEmail`. The `does not email` cases pass vacuously; that is expected and they turn meaningful once the code exists.

- [ ] **Step 3: Add the send to `setTrustState`**

In `apps/api/src/services/partnerTrust.ts`, add to the imports:

```ts
import { sendTrustApprovedEmail } from './partnerTrustPartnerMail';
```

Replace the tail of `setTrustState` — from `await createAuditLog({` through `return true;` — with:

```ts
  await createAuditLog({
    orgId: null,
    actorType: actorUserId ? 'user' : 'system',
    actorId: actorUserId ?? ANONYMOUS_ACTOR_ID,
    action: next === 'trusted'
      ? 'partner.trust.promoted'
      : next === 'restricted'
        ? 'partner.trust.restricted'
        : 'partner.trust.probation',
    resourceType: 'partner',
    resourceId: partnerId,
    result: 'success',
    details: { from: before?.trustState ?? null, to: next, reason, ...evidence },
  });
  // Partner-facing approval notice (#8713): only the probation → trusted
  // transition, keyed off the same `before` the audit row used so the two
  // never disagree. Every promotion path (auto CAS, admin route, evidence-card
  // link) lands here. The sender is inert outside `enforce` mode and never
  // throws; the guard keeps the trust write's contract independent of that.
  if (before?.trustState === 'probation' && next === 'trusted') {
    try {
      await sendTrustApprovedEmail({ partnerId });
    } catch (error) {
      console.warn('[partnerTrust] Failed to send approval email:', error);
    }
  }
  return true;
```

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `cd apps/api && npx vitest run services/partnerTrust.test`
Expected: PASS.

Also run the two route suites that exercise the real `setTrustState` with the repo mocked, to confirm they still pass before Task 5 adds explicit mocks:

Run: `cd apps/api && npx vitest run routes/admin/trust`
Expected: PASS. (`partnerTrustMode()` resolves to `off` in tests because `IS_HOSTED` is unset, so the sender returns 0 before touching the mocked db.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/partnerTrust.ts apps/api/src/services/partnerTrust.test.ts
git commit -m "feat(api): email partner admins on probation → trusted (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Admin promote/restrict becomes a compare-and-swap

**Files:**
- Modify: `apps/api/src/routes/admin/trust.ts` (`changeTrustState`)
- Modify: `apps/api/src/routes/admin/trust.test.ts` (mocks block; the promote tests)

**Interfaces:**
- Consumes: `setTrustState(..., { expectedFrom })` returning `false` on a lost CAS (existing behaviour).
- Produces: `POST /admin/partners/:id/trust/promote` and `/restrict` return `409 { error: 'trust state changed since the queue was loaded; refresh and retry' }` when the row no longer matches the state the handler loaded.

- [ ] **Step 1: Add the mail-module mock and the failing tests**

In `apps/api/src/routes/admin/trust.test.ts`, after `vi.mock('../../services/partnerTrustEvidenceCard', () => ({ buildEvidenceCard }));` add:

```ts
vi.mock('../../services/partnerTrustPartnerMail', () => ({
  sendTrustApprovedEmail: vi.fn(async () => 0),
}));
```

Update the existing test `'promotes with override and records the trust-service audit evidence'`: change the `writeTrust` assertion to include the CAS argument:

```ts
    expect(writeTrust).toHaveBeenCalledWith(
      'p-1',
      'trusted',
      'admin:promote',
      auth.user.id,
      'restricted',
    );
```

Then add, after that test:

```ts
  it('promotes a probation partner with a CAS on the loaded state', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'review completed' }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith('p-1', 'trusted', 'admin:promote', auth.user.id, 'probation');
  });

  it('returns 409 and writes no audit row when the CAS loses', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    writeTrust.mockResolvedValueOnce(0 as never);
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'review completed' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'trust state changed since the queue was loaded; refresh and retry' });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('restricts with a CAS on the loaded state', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/restrict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual restriction' }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith('p-1', 'restricted', 'admin:restrict', auth.user.id, 'probation');
  });
```

Confirm `createAuditLog` is imported in this test file (it is used by the existing override test). If `writeTrust` is typed `vi.fn(async () => undefined)`, the `0 as never` cast is what lets `mockResolvedValueOnce(0)` typecheck; vitest runs it either way.

- [ ] **Step 2: Run the admin route tests to verify the new ones fail**

Run: `cd apps/api && npx vitest run routes/admin/trust.test`
Expected: FAIL — the three CAS tests and the updated override test report `writeTrust` called with four arguments, and the lost-CAS test gets 200 instead of 409.

- [ ] **Step 3: Pass the loaded state through and handle the lost CAS**

In `apps/api/src/routes/admin/trust.ts`, replace the body of `changeTrustState` from `const action = …` to the end of the function with:

```ts
  const action = next === 'trusted' ? 'admin:promote' : 'admin:restrict';
  // CAS on the state this handler loaded: if an auto-promotion, another
  // operator, or a lapse (#8714) moved the row in between, the write affects
  // zero rows and setTrustState returns false with no audit row, no publish
  // and no partner email. The operator refreshes the queue and decides again
  // against the current state.
  const landed = await setTrustState(partnerId, next, action, auth.user.id, { reason }, { expectedFrom: current.trustState });
  if (!landed) {
    return c.json({ error: 'trust state changed since the queue was loaded; refresh and retry' }, 409);
  }
  return c.json({ success: true, trustState: next });
```

- [ ] **Step 4: Run the admin route tests to verify they pass**

Run: `cd apps/api && npx vitest run routes/admin/trust.test`
Expected: PASS.

- [ ] **Step 5: Confirm the web trust queue surfaces the 409 without a code change**

Read `apps/web/src/components/admin/TrustQueue.tsx` around the `runAction({ … errorFallback: \`Unable to ${action} partner\` … })` call. `runAction` toasts the server's `error` string for a non-2xx response, and the `catch` only special-cases 401/403, so a 409 toasts `trust state changed since the queue was loaded; refresh and retry` and leaves the row in place. No web change. Record this in the PR body.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/trust.ts apps/api/src/routes/admin/trust.test.ts
git commit -m "fix(api): admin trust promote/restrict is a compare-and-swap on the loaded state (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Migrate the three existing Partner Admin query sites to the helper

**Files:**
- Modify: `apps/api/src/services/emailDomains/statusMail.ts` (`resolveRecipients` and the comment above it; imports)
- Modify: `apps/api/src/services/tenantOffboarding.ts` (the `recipients` query in the archive purge-warning loop, around line 2049; imports)
- Modify: `apps/api/src/routes/auth/accountDeletion.ts` (`findOrgAdminRecipients`; imports)
- Test (existing, unchanged): `apps/api/src/services/emailDomains/statusMail.test.ts`, `apps/api/src/services/tenantOffboarding.test.ts`, `apps/api/src/routes/auth/accountDeletion.test.ts`, `apps/api/src/routes/auth/accountDeletion.admin.test.ts`

**Interfaces:**
- Consumes: `listActivePartnerAdmins` (Task 1).
- Produces: no behaviour change at any site. The three existing test files are the guard and are not edited.

This is a mechanical commit on its own. If any site cannot be migrated without changing a test, leave that site as it is, update its comment to point at `services/partnerAdminRecipients.ts`, and say so in the PR body.

- [ ] **Step 1: Run the three existing suites to record a green baseline**

Run: `cd apps/api && npx vitest run statusMail tenantOffboarding accountDeletion`
Expected: PASS. Note the test counts.

- [ ] **Step 2: Migrate `statusMail.ts`**

Replace the `resolveRecipients` function and its doc comment with:

```ts
/**
 * Recipients: the user who added the domain plus the partner's active
 * Partner Admins (spec §6.3). The adder lookup runs in SYSTEM scope —
 * `users` is partner-axis and this is called from the worker, which has no
 * tenant context at all. The admin list comes from the shared helper.
 */
async function resolveRecipients(input: SendingDomainStatusMailInput): Promise<string[]> {
  const out: string[] = [];
  if (input.createdBy) {
    const creator = await withSystemDbAccessContext(async () => db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, input.createdBy!), eq(users.status, 'active')))
      .limit(1), 'sendingDomainStatusMailRecipients');
    const email = creator[0]?.email?.trim();
    if (email) out.push(email);
  }
  for (const admin of await listActivePartnerAdmins(input.partnerId)) out.push(admin.email);
  return [...new Set(out)];
}
```

Update the imports: add `import { listActivePartnerAdmins } from '../partnerAdminRecipients';` and remove `partnerUsers` and `roles` from the `../../db/schema` import (keep `users`).

- [ ] **Step 3: Run the statusMail suite**

Run: `cd apps/api && npx vitest run statusMail`
Expected: PASS with the same count as Step 1. The test queues one db result for the creator lookup and one for the admin list; the helper consumes the second through the same mocked chain.

- [ ] **Step 4: Migrate `tenantOffboarding.ts`**

Replace the `recipients` query block (the `await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select({ email: users.email }).from(partnerUsers)…` statement and the `emails` line that follows it) with:

```ts
        const recipients = await listActivePartnerAdmins(org.partnerId);
        const emails = recipients.map((recipient) => recipient.email);
```

Add `import { listActivePartnerAdmins } from './partnerAdminRecipients';` to the imports. Remove `partnerUsers` and `roles` from the schema import only if nothing else in the file uses them (grep first; `users` stays).

- [ ] **Step 5: Run the tenantOffboarding suite**

Run: `cd apps/api && npx vitest run tenantOffboarding`
Expected: PASS with the same count as Step 1. The test at `'selects recipients by the established Partner Admin role'` introspects the captured `where` clause for `partnerUsers.partnerId`, `roles.name` and `Partner Admin`; the helper builds the same clause through the same mocked chain.

- [ ] **Step 6: Migrate `accountDeletion.ts`**

Replace `findOrgAdminRecipients` with:

```ts
async function findOrgAdminRecipients(opts: {
  partnerId: string | null;
  excludeUserId: string;
}): Promise<AdminRecipient[]> {
  if (!opts.partnerId) return [];
  // Anyone with a `Partner Admin` role under the same partner — the staff with
  // full admin access for this tenant — except the requester themselves.
  const admins = await listActivePartnerAdmins(opts.partnerId);
  return admins
    .filter((admin) => admin.id !== opts.excludeUserId)
    .map((admin) => ({ email: admin.email, name: admin.name }));
}
```

Add `import { listActivePartnerAdmins } from '../../services/partnerAdminRecipients';`. Remove `partnerUsers` and `roles` from the schema import and `ne` from the drizzle import if nothing else in the file uses them (grep first). Leave `runWithSystemDbAccess` in place: other queries in the file still use it.

- [ ] **Step 7: Run both accountDeletion suites**

Run: `cd apps/api && npx vitest run accountDeletion`
Expected: PASS with the same counts as Step 1. Both files mock `../../db` with `runOutsideDbContext` and `withSystemDbAccessContext` as pass-throughs and mock the select chain with `innerJoin → innerJoin → where`, which is the chain the helper calls.

- [ ] **Step 8: Run the helper suite and lint the touched files**

Run: `cd apps/api && npx vitest run partnerAdminRecipients && npx eslint src/services/emailDomains/statusMail.ts src/services/tenantOffboarding.ts src/routes/auth/accountDeletion.ts src/services/partnerAdminRecipients.ts`
Expected: PASS, no unused-import errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/emailDomains/statusMail.ts apps/api/src/services/tenantOffboarding.ts apps/api/src/routes/auth/accountDeletion.ts
git commit -m "refactor(api): use listActivePartnerAdmins at the three existing Partner Admin recipient sites (#8713)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Whole-branch verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Typecheck the API without piping through `tail`**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "tsc exit=$?"`
Expected: `tsc exit=0`. A non-zero exit with no errors printed is a heap OOM, not a pass; re-run with a larger heap.

- [ ] **Step 2: Run every suite this branch touches**

Run: `cd apps/api && npx vitest run partnerTrust partnerAdminRecipients mailPurposes email.golden statusMail tenantOffboarding accountDeletion trustAct`
Expected: PASS. `partnerTrust` is a substring filter and also picks up `partnerTrustPromotion`, `partnerTrustEvidenceCard`, `partnerTrustJobs`, `routes/partnerTrust`, `routes/admin/trust` and `routes/admin/trustAct`.

- [ ] **Step 3: Run the full API unit suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS. No contract suite (RLS, org-cascade, export-policy) is needed: no table, column, or tenancy shape changed.

- [ ] **Step 4: Lint**

Run: `cd apps/api && pnpm lint`
Expected: clean.

- [ ] **Step 5: Confirm the public artefacts carry only the rules, not the reasoning**

Grep the branch diff for anything that explains *why* restriction sends no email, *why* the review-received copy avoids a turnaround, or *why* `status = 'active'` matters:

Run: `git diff main...HEAD -- apps/ | grep -niE "fraud|scam|tip.?off|operator|manual.?sql|backfill" ; echo "grep exit=$?"`
Expected: `grep exit=1` (no matches). The spec and this plan state those as bare rules; the diff must do the same.

- [ ] **Step 6: Open the PR**

Push the branch and open a PR against `main` with `Closes #8713`. Body sections: what changed (the five commits), the spec link, "no web change: the 409 toasts through `runAction`", the Settings rule-9 line is not applicable (no setting added), and the test commands from Steps 1–3 with their results. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

# Ticketing Phase 4 — Outbound Threading + Autoresponder + Loop Prevention (PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the outbound half of email-to-ticket. When a technician posts a public comment, the requester gets a properly **threaded** reply (`Message-ID` / `In-Reply-To` / `References` / `Reply-To` + a `[T-YYYY-NNNN]` subject token) that lands in the same conversation in their mail client. When an email-sourced ticket is created for an **accepted** sender, they get exactly one **autoresponse** acknowledgement. Every outbound piece is hardened against mail loops (`Auto-Submitted` stamping + inbound-header suppression + self-domain + a per-sender Redis cap), and an internal note can never leak into an outbound email.

**Architecture:** Reuse the **existing** `ticketNotifyWorker` (spec §1 — no second outbound worker). This PR (a) extends `services/email.ts`'s `SendEmailParams` with a `headers?` map and threads it through all three providers (Resend / SMTP / Mailgun); (b) adds threading metadata to the notify worker's `ticket.commented` public-comment branch (already guarded against inbound echo by PR1) **without** changing the un-threaded `ticket.status_changed` "Resolved" email; (c) adds a one-time autoresponder fired on the email-created-ticket path for **accepted senders only**, with loop-prevention checks performed in `inboundEmailService` (PR1's dispatch core) before the autoresponder event is emitted; (d) adds the loop-prevention suppression module + per-sender Redis cap; (e) extends the internal-note leak regression to the outbound composer.

**Tech Stack:** Hono + Drizzle + Zod + BullMQ + Vitest. Redis sliding-window via the existing `rateLimiter`. No new tables, no migrations, no new env vars (PR1 already adds `TICKETS_INBOUND_DOMAIN` + `MAILGUN_INBOUND_SIGNING_KEY` to `apps/api/src/config/validate.ts`).

**Spec:** `docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md` (decision **D1** full loop + autoresponder; **§2** config — inbound address is a *derived default, overridable for self-hosted*; **§5** outbound threading / autoresponder / loop prevention; **§6** isolation + internal-note leak; **§9** regression tests; **§1** reuse `ticketNotifyWorker`).

**Scope of THIS plan (spec §11 PR 3).** Outbound only. **Out of scope (other PRs):** the inbound webhook/worker/schema tables, `MailgunInboundProvider`, `resolvePartnerByRecipient`, `appendInboundComment`, the `createTicket` `submitterEmail` extension, the `ticket.commented` `inbound?` flag + the notify-worker echo guard, the `TICKETS_INBOUND_DOMAIN`/`MAILGUN_INBOUND_SIGNING_KEY` config keys, **and the ingest-time self-loop drop** (see "Self-loop boundary" below) — **all of those land in PR1** (`docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md` ingest plan). The Settings UI + review queue is **PR4 (frontend)** — not here.

---

## Hard dependency on PR1 (read before starting)

This plan **builds on top of PR1** and must be branched **after PR1 is merged** (or rebased onto it). Specifically it relies on these PR1 artifacts existing, **with these exact shapes**:

1. **`apps/api/src/services/inboundEmail/inboundEmailService.ts`** — the `processInboundEmail` dispatch core (PR1 Task 9). PR3 adds the autoresponder emit + loop-prevention gate **inside** the existing `createFromEmail` success path here. **Pinned precondition — `createFromEmail`'s signature MUST be:**

   ```typescript
   async function createFromEmail(
     n: NormalizedInboundEmail,
     partnerId: string,
     orgId: string,
     carryThreadKey: string | null,
     priorNumber: string | null,
     submittedBy?: string,
   ): Promise<{ id: string; /* ...persisted ticket row */ }>
   ```

   with the two PR1 call sites being:
   - known-sender fresh ticket: `createFromEmail(n, partnerId, sender.orgId, null, null, sender.id)` → `submittedBy` set, `priorNumber` null;
   - closed-continuation: `createFromEmail(n, partnerId, matched.orgId, matched.emailThreadKey, matched.internalNumber)` → `priorNumber` set, `submittedBy` undefined.

   PR3's autoresponse placement (Task 6 Step 5) keys on `submittedBy && !priorNumber` to fire **only** on the fresh known-sender path. **Task 6 Step 5 includes a guard that throws if the signature differs**, so a renamed/re-ordered PR1 parameter fails loudly instead of silently autoresponding on the wrong path. If the grep in Task 6 Step 5 shows a different signature, **stop and reconcile with PR1** — do not adapt the gate to fire on an unverified path.

2. **`apps/api/src/services/inboundEmail/types.ts`** — `NormalizedInboundEmail` already carries `autoSubmitted?: string` and `precedence?: string` (PR1 Task 4). PR3 consumes them.

3. **`tickets.submitterEmail`/`submitterName` populated for `source:'email'`** (PR1 Task 8 `createTicket` extension).

4. **`TICKETS_INBOUND_DOMAIN` added to `apps/api/src/config/validate.ts`'s `envSchema`** (PR1 config change), read via the canonical accessor `getConfig().TICKETS_INBOUND_DOMAIN`. **There is no `apps/api/src/config.ts` and no `export const config` singleton** — the only config accessor in this codebase is `getConfig()` exported from `apps/api/src/config/validate.ts` (verified: `services/partnerHooks.ts:33` does `const config = getConfig();`). Every config read and every test mock in this plan uses that accessor. **PR1's plan must add `TICKETS_INBOUND_DOMAIN` to `envSchema` in `validate.ts` so `getConfig().TICKETS_INBOUND_DOMAIN` is typed**; Task 0 below greps for it as a hard precondition.

If PR1 is not yet merged when you start, **stop and land PR1 first** — the autoresponder has no `processInboundEmail` to hang off and no `submitterEmail` to send to.

## Self-loop boundary (PR1 vs PR3)

Spec §5 has two distinct self-loop requirements, split across PRs:

- **Ingest-time DROP of self-loop mail** ("Drop mail whose sender is our own `tickets.<domain>`") is **PR1's responsibility** — it belongs in PR1's `processInboundEmail` dispatch, which resolves such mail to `parse_status='ignored'`/`'dropped'` *before* any ticket/quarantine decision. PR3 does **not** own the ingest decision. **Precondition (Task 0 greps for it):** PR1 must drop mail whose sender domain equals `TICKETS_INBOUND_DOMAIN`. If PR1 did not implement it, file/raise it against PR1 — do **not** patch the ingest decision from PR3.
- **Autoresponse-time suppression of self-loop mail** is **PR3's responsibility** (defense-in-depth): the `self-domain` rule in `loopPrevention.ts` (Task 5) guarantees PR3 never autoresponds to a self-addressed message even if one reaches the created-for-known-sender path. This is the only self-loop behavior PR3 implements.

## Config access pattern (applies to every Task that reads config)

**Always** `import { getConfig } from '../config/validate'` (from `jobs/` — one level up) **or** `import { getConfig } from '../../config/validate'` (from `services/inboundEmail/` — two levels up), then `getConfig().TICKETS_INBOUND_DOMAIN`. **Never** `import { config } from '../config'` / `'../../config'` (that module does not exist and will not resolve/compile).

**Test mocks** stub the accessor, not a singleton:
```typescript
// from services/inboundEmail/* test files:
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
// from jobs/* test files:
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
```

**Plan-level decisions (deltas/clarifications vs spec, decided here):**
- **Deterministic outbound Message-ID (no new column):** the outbound reply's `Message-ID` is generated as `<ticket-${ticketId}-${commentId}@${TICKETS_INBOUND_DOMAIN}>` and the **conversation thread anchor** stored in `tickets.email_thread_key` is the ticket's first outbound Message-ID `<ticket-${ticketId}@${TICKETS_INBOUND_DOMAIN}>`. `In-Reply-To`/`References` are set to that anchor so the requester's reply (and Mailgun's `In-Reply-To` on the way back in) thread-matches PR1's `email_thread_key` resolver. No per-comment ID column is added — generation is deterministic from `ticketId`/`commentId` (resolves spec §5 / contract open-question 2).
- **Only the technician comment-reply path threads.** The existing `ticket.status_changed` ("Resolved") email keeps its current un-threaded behavior — it does **not** emit a `Message-ID`/`In-Reply-To`. Threading is opt-in per call site (a `commentId` argument) so the Resolved path can never emit a bare-anchor `Message-ID` that would collide with the autoresponse's `Message-ID` (both would otherwise be `<ticket-${id}@domain>`). See Task 4.
- **`SendEmailParams.headers` is a flat `Record<string, string>`** (resolves contract open-question 1). Flat is simplest and maps cleanly onto Mailgun's `h:Header-Name` form fields, Resend's `headers` object, and nodemailer's `headers` option. Callers pass `{ 'Message-ID': ..., 'In-Reply-To': ..., 'References': ..., 'Auto-Submitted': ... }`. `Reply-To` keeps using the existing `replyTo` param (Mailgun already maps it to `h:Reply-To`; do not also set it via `headers` or it double-encodes).
- **Inbound (Reply-To) address honors the self-hosted override.** Per spec §2, the partner inbound address is a *derived default, overridable for self-hosted* via `partners.settings.ticketing.inbound.address`. The `partnerInboundAddress` helper reads the configured override first and falls back to `{slug}@TICKETS_INBOUND_DOMAIN`. This keeps PR3's `Reply-To` identical to whatever PR1's `resolvePartnerByRecipient` accepts as inbound (Task 3).
- **Autoresponder is fired by `inboundEmailService`, not the notify worker.** It is a distinct, one-time acknowledgement (not a comment notification), gated on loop-prevention + the partner's `autoresponderEnabled` setting + the per-sender Redis cap. It enqueues onto the **existing** `ticket-events` queue as a new `ticket.autoresponse` event so the actual SMTP send happens in the notify worker (one outbound code path, spec §1). No second worker.
- **Per-sender autoresponse cap:** `rateLimiter(getRedis(), `autoresponse:${senderEmail}`, 1, 86400)` — **1 per sender per 24h** (resolves contract open-question 5; bounds backscatter on a stranger who re-emails). The PR1 idempotency check already prevents re-sending on provider retries of the *same* message; this cap bounds *distinct* messages from a runaway sender.
- **Autoresponder default = on:** read `partners.settings.ticketing.inbound.autoresponderEnabled`, default **`true`** when unset (resolves contract open-question 6; spec §2 config shows `true`).
- **Autoresponse template is hardcoded (stubbed) this phase.** Partner-branded template config is PR4/Settings work (spec §7). A plain acknowledgement carrying `[T-YYYY-NNNN]` ships now; the helper is a single function so PR4 can swap the body. **Subject tokenization comes solely from the template:** when `internalNumber` is null the autoresponse subject has no `[T-...]` token (the template degrades gracefully). This is intentional — a `source:'email'` ticket always has an `internalNumber` by the time the autoresponse fires (it is assigned at insert), so the token-less branch is a defensive fallback, not the happy path.
- **Dropped-autoresponse logging:** when a loop-prevention rule (or the Redis cap, or the disabled setting) suppresses an autoresponse, log at `console.info('[InboundEmail] autoresponse suppressed', ...)` only — no UI surface in v1 (resolves contract open-question 4).

**Worktree:** create via superpowers:using-git-worktrees from `origin/main` (with PR1 merged), branch `feat/ticketing-email-outbound`. Run `pnpm install` in fresh worktrees; **symlink the gitignored `.env.test`**. Prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. First commit: this plan.

---

### Task 0: Confirm PR1 preconditions (no code — guardrail)

**Files:** none (read-only verification).

- [ ] **Step 1: Verify every PR1 artifact PR3 layers on exists with the expected shape.** Run all greps; **stop and rebase onto PR1 if any fails:**

```bash
cd apps/api
# (a) config key is in the envSchema (so getConfig().TICKETS_INBOUND_DOMAIN is typed):
grep -n "TICKETS_INBOUND_DOMAIN" src/config/validate.ts
# (b) the dispatch core + the createFromEmail signature PR3's gate keys on:
grep -n "export async function processInboundEmail" src/services/inboundEmail/inboundEmailService.ts
grep -n "function createFromEmail" src/services/inboundEmail/inboundEmailService.ts
# (c) NormalizedInboundEmail carries the loop-prevention header fields:
grep -n "autoSubmitted\|precedence" src/services/inboundEmail/types.ts
# (d) ticket.commented already carries the inbound? echo guard (PR1 Task 10):
grep -n "inbound" src/services/ticketEvents.ts src/jobs/ticketNotifyWorker.ts
# (e) ingest-time self-loop DROP is PR1's (sender domain == TICKETS_INBOUND_DOMAIN):
grep -n "TICKETS_INBOUND_DOMAIN\|self-loop\|self-domain\|dropped" src/services/inboundEmail/inboundEmailService.ts
```

Expected: (a) present; (b) `processInboundEmail` present and `createFromEmail(n, partnerId, orgId, carryThreadKey, priorNumber, submittedBy?)` present; (c) both fields present; (d) `inbound?: boolean` on `ticket.commented.payload` and `!event.payload.inbound` in the worker; (e) PR1 drops self-addressed mail at ingest. **A miss on (a)–(d) means PR1 is not merged/rebased — stop.** A miss on (e) is a PR1 gap to raise against PR1, not patch here (see "Self-loop boundary"); PR3's Task 5 `self-domain` rule still provides the autoresponse-time backstop, so PR3 may proceed while (e) is tracked separately.

- [ ] **Step 2: Confirm there is no `config` singleton (so you write the right import).**

```bash
cd apps/api && grep -rn "export const config" src/ || echo "CONFIRMED: no config singleton — use getConfig() from config/validate"
ls src/config.ts 2>&1   # expect: No such file or directory
```

---

### Task 1: `SendEmailParams.headers` — interface + Resend/SMTP wiring

**Files:**
- Modify: `apps/api/src/services/email.ts` (interface ~line 10-17; `sendEmail` Resend branch ~line 156; SMTP branch ~line 190)
- Create: `apps/api/src/services/email.headers.test.ts`

The composer reaches three providers. Resend and nodemailer both accept a `headers` object natively; Mailgun needs the `h:` mapping (Task 2). This task does the interface + the two native providers, with a provider-agnostic test that mocks both transports. (Note `email.ts` reads provider config straight from `process.env` — no `getConfig()` here; the tests set `process.env` accordingly.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/email.headers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resendSendMock, smtpSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn().mockResolvedValue({ error: null }),
  smtpSendMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: resendSendMock } })),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: smtpSendMock })) },
}));

describe('SendEmailParams.headers — Resend', () => {
  beforeEach(() => {
    vi.resetModules();
    resendSendMock.mockClear();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'support@example.com';
  });

  it('passes custom headers to resend.emails.send', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: '[T-2026-0001] Re: printer',
      html: '<p>hi</p>',
      headers: { 'In-Reply-To': '<ticket-t1@tickets.example.com>', 'Auto-Submitted': 'auto-replied' },
    });
    const arg = resendSendMock.mock.calls[0][0];
    expect(arg.headers).toEqual({
      'In-Reply-To': '<ticket-t1@tickets.example.com>',
      'Auto-Submitted': 'auto-replied',
    });
  });
});

describe('SendEmailParams.headers — SMTP', () => {
  beforeEach(() => {
    vi.resetModules();
    smtpSendMock.mockClear();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'localhost';
    process.env.SMTP_FROM = 'support@example.com';
    delete process.env.RESEND_API_KEY;
  });

  it('merges custom headers into nodemailer mailOptions', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', References: '<a> <b>' },
    });
    const arg = smtpSendMock.mock.calls[0][0];
    expect(arg.headers).toEqual({ 'Message-ID': '<m@x>', References: '<a> <b>' });
  });
});
```

> Confirm `EmailService` is exported (it is constructed in `getEmailService` ~line 269). If the class is not exported, add `export` to its declaration in this same step.

- [ ] **Step 2: Run the test — expect FAIL** (`headers` not on the interface / not forwarded):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/email.headers.test.ts --pool=forks
```

- [ ] **Step 3: Add `headers` to the interface and forward it (Resend + SMTP)**

In `apps/api/src/services/email.ts`, extend the interface (lines 10-17):

```typescript
export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string | string[];
  // Custom RFC headers for threading + loop-prevention (Phase 4):
  // Message-ID, In-Reply-To, References, Auto-Submitted. Flat map; each
  // provider maps it natively (Resend/SMTP `headers`, Mailgun `h:` fields).
  headers?: Record<string, string>;
}
```

In `sendEmail`, destructure `headers` (line 148) and pass it to Resend (line 156) and SMTP (line 190):

```typescript
    const { to, subject, html, text, from, replyTo, headers } = params;
```

Resend branch — add `headers`:

```typescript
      const { error } = await this.resend.emails.send({
        from: sender,
        to,
        subject,
        html,
        text,
        replyTo,
        headers,
      });
```

SMTP branch — add `headers`:

```typescript
    await this.smtpTransport.sendMail({
      from: sender,
      to,
      subject,
      html,
      text,
      replyTo,
      headers,
    });
```

(Leave the Mailgun branch's `sendViaMailgun(...)` call as-is for now — Task 2 threads `headers` into it.)

- [ ] **Step 4: Run the test — expect PASS:**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/email.headers.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.headers.test.ts
git commit -m "feat(email): SendEmailParams.headers → Resend + SMTP custom headers (Phase 4)"
```

---

### Task 2: Mailgun custom-header mapping (`h:` form fields)

**Files:**
- Modify: `apps/api/src/services/email.ts` (`sendEmail` Mailgun branch ~line 175; `sendViaMailgun` ~line 460-500)
- Modify: `apps/api/src/services/email.headers.test.ts`

Mailgun expects each custom header as a `h:Header-Name=value` form field (the existing code already does this for `h:Reply-To` at line 481). Thread `params.headers` through.

- [ ] **Step 1: Add the failing Mailgun test** — append to `apps/api/src/services/email.headers.test.ts`:

```typescript
describe('SendEmailParams.headers — Mailgun', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.MAILGUN_FROM = 'support@example.com';
    process.env.EMAIL_FROM = 'support@example.com';
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
  });

  it('emits each custom header as an h:Header-Name form field', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', 'In-Reply-To': '<a@x>', 'Auto-Submitted': 'auto-replied' },
    });
    const body = fetchMock.mock.calls[0][1].body as string;
    const params = new URLSearchParams(body);
    expect(params.get('h:Message-ID')).toBe('<m@x>');
    expect(params.get('h:In-Reply-To')).toBe('<a@x>');
    expect(params.get('h:Auto-Submitted')).toBe('auto-replied');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no `h:Message-ID` in body):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/email.headers.test.ts -t Mailgun --pool=forks
```

- [ ] **Step 3: Thread `headers` into the Mailgun call + the form builder**

In `sendEmail`'s Mailgun branch (~line 175), add `headers`:

```typescript
      await sendViaMailgun(this.mailgunConfig, {
        from: sender,
        to,
        subject,
        html,
        text,
        replyTo,
        headers,
      });
```

In `sendViaMailgun` (~line 460-500), after the existing `h:Reply-To` block (after line 483), add:

```typescript
  if (params.headers) {
    for (const [name, value] of Object.entries(params.headers)) {
      // Reply-To is already mapped above via the replyTo param — skip to avoid
      // double-encoding if a caller also passes it in headers.
      if (name.toLowerCase() === 'reply-to') continue;
      body.set(`h:${name}`, value);
    }
  }
```

(`sendViaMailgun`'s param type is `SendEmailParams & { from: string }`, so `params.headers` already type-checks after Task 1.)

- [ ] **Step 4: Run — expect PASS** (Mailgun + the Task 1 suites):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/email.headers.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.headers.test.ts
git commit -m "feat(email): map SendEmailParams.headers to Mailgun h: form fields (Phase 4)"
```

---

### Task 3: Threading-header helper (`buildThreadingHeaders` + `partnerInboundAddress`)

**Files:**
- Create: `apps/api/src/services/inboundEmail/outboundThreading.ts`
- Create: `apps/api/src/services/inboundEmail/outboundThreading.test.ts`

A pure helper that produces the deterministic Message-ID set + the `Reply-To` partner address for a given ticket/comment. Keeping it standalone makes the loop-prevention `Auto-Submitted` value and the thread-anchor format testable in isolation and reusable by both the comment-reply path (Task 4) and the autoresponder (Task 6). `partnerInboundAddress` honors the self-hosted override (spec §2) and falls back to the derived `{slug}@TICKETS_INBOUND_DOMAIN`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/inboundEmail/outboundThreading.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));

import {
  ticketThreadAnchor,
  commentMessageId,
  buildThreadingHeaders,
  partnerInboundAddress,
} from './outboundThreading';

describe('outbound threading helpers', () => {
  it('ticketThreadAnchor is deterministic from ticketId', () => {
    expect(ticketThreadAnchor('t-1')).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('commentMessageId is deterministic from ticketId + commentId', () => {
    expect(commentMessageId('t-1', 'c-9')).toBe('<ticket-t-1-c-9@tickets.example.com>');
  });

  it('partnerInboundAddress derives {slug}@TICKETS_INBOUND_DOMAIN by default', () => {
    expect(partnerInboundAddress('acme', undefined)).toBe('acme@tickets.example.com');
  });

  it('partnerInboundAddress honors the self-hosted override (spec §2)', () => {
    // partner.settings.ticketing.inbound.address overrides the derived default.
    expect(partnerInboundAddress('acme', 'support@helpdesk.theirmsp.com'))
      .toBe('support@helpdesk.theirmsp.com');
  });

  it('partnerInboundAddress ignores a blank override and falls back to the derived default', () => {
    expect(partnerInboundAddress('acme', '   ')).toBe('acme@tickets.example.com');
  });

  it('buildThreadingHeaders sets Message-ID, In-Reply-To, References to the anchor', () => {
    const h = buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' });
    expect(h['Message-ID']).toBe('<ticket-t-1-c-9@tickets.example.com>');
    expect(h['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
    expect(h['References']).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('buildThreadingHeaders without commentId (autoresponse) uses the anchor as Message-ID', () => {
    const h = buildThreadingHeaders({ ticketId: 't-1' });
    expect(h['Message-ID']).toBe('<ticket-t-1@tickets.example.com>');
    expect(h['In-Reply-To']).toBeUndefined();
  });

  it('returns empty headers / null address when TICKETS_INBOUND_DOMAIN is unset', async () => {
    vi.resetModules();
    vi.doMock('../../config/validate', () => ({ getConfig: () => ({}) }));
    const mod = await import('./outboundThreading');
    expect(mod.buildThreadingHeaders({ ticketId: 't-1', commentId: 'c-9' })).toEqual({});
    expect(mod.partnerInboundAddress('acme', undefined)).toBeNull();
    // …but a configured override still wins even with no platform domain (self-hosted):
    expect(mod.partnerInboundAddress('acme', 'support@helpdesk.theirmsp.com'))
      .toBe('support@helpdesk.theirmsp.com');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/outboundThreading.test.ts --pool=forks
```

- [ ] **Step 3: Implement**

Create `apps/api/src/services/inboundEmail/outboundThreading.ts`:

```typescript
import { getConfig } from '../../config/validate';

function domain(): string | undefined {
  return getConfig().TICKETS_INBOUND_DOMAIN;
}

/** The conversation thread anchor — stored as tickets.email_thread_key and used
 *  as In-Reply-To/References on every outbound message for the ticket. */
export function ticketThreadAnchor(ticketId: string): string | null {
  const d = domain();
  return d ? `<ticket-${ticketId}@${d}>` : null;
}

/** Deterministic Message-ID for one outbound comment reply. */
export function commentMessageId(ticketId: string, commentId: string): string | null {
  const d = domain();
  return d ? `<ticket-${ticketId}-${commentId}@${d}>` : null;
}

/**
 * The partner's inbound (Reply-To) address. Spec §2: the address is a derived
 * default ({slug}@TICKETS_INBOUND_DOMAIN), OVERRIDABLE for self-hosted via
 * partners.settings.ticketing.inbound.address. The override wins (and is used
 * even when no platform domain is configured); a blank/whitespace override is
 * ignored. Must match what PR1's resolvePartnerByRecipient accepts as inbound.
 */
export function partnerInboundAddress(
  partnerSlug: string,
  configuredOverride: string | undefined,
): string | null {
  const override = configuredOverride?.trim();
  if (override) return override;
  const d = domain();
  return d ? `${partnerSlug}@${d}` : null;
}

/** Threading header set. With a commentId → a reply (In-Reply-To/References =
 *  anchor); without → the autoresponse (Message-ID = anchor, no In-Reply-To). */
export function buildThreadingHeaders(args: { ticketId: string; commentId?: string }): Record<string, string> {
  const anchor = ticketThreadAnchor(args.ticketId);
  if (!anchor) return {};
  if (!args.commentId) {
    return { 'Message-ID': anchor };
  }
  const mid = commentMessageId(args.ticketId, args.commentId);
  return {
    'Message-ID': mid ?? anchor,
    'In-Reply-To': anchor,
    References: anchor,
  };
}
```

- [ ] **Step 4: Run — expect PASS:**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/outboundThreading.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/outboundThreading.ts apps/api/src/services/inboundEmail/outboundThreading.test.ts
git commit -m "feat(ticketing): outbound threading header helper + partner inbound address (override-aware)"
```

---

### Task 4: Thread the outbound comment reply in `ticketNotifyWorker` (comment path ONLY)

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (`EmailPayload` ~line 45-50; line-31 import; `collectRequesterEmail` ~line 117-137; `ticket.commented` branch ~line 204-213; `ticket.status_changed` branch ~line 219-229; send loop ~line 241-252)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.test.ts`

The worker already (post-PR1) skips inbound echoes (`event.payload.isPublic && !event.payload.inbound`). PR3 makes the *technician* public-comment reply threaded: a real subject (`[T-YYYY-NNNN] <subject>`), a `Reply-To` = the partner's inbound address, and the `Message-ID`/`In-Reply-To`/`References` headers from Task 3. The thread anchor is also stamped onto `tickets.email_thread_key` the first time so the requester's reply matches PR1's resolver.

> **Shared-helper side-effect — explicitly handled.** `collectRequesterEmail` is ALSO called by the `ticket.status_changed` ("Resolved") branch (~line 219-229) with `subjectPrefix='Resolved'`. Threading must NOT leak onto that path: if it did, the Resolved email would emit a bare-anchor `Message-ID` (`commentId` undefined → `<ticket-${id}@domain>`) that **collides** with the autoresponse's `Message-ID` (also the bare anchor), confusing the requester's mail client and PR1's resolver. To prevent this, threading is **opt-in per call**: `collectRequesterEmail` only produces `Reply-To`/`headers`/anchor-stamping when a `commentId` is passed. The `ticket.commented` branch passes it; the `ticket.status_changed` branch does NOT (its email stays exactly as today — no headers, no Reply-To, no anchor stamp). A test asserts the Resolved email is unthreaded.

> **PR1 boundary:** the `inbound?` flag on `ticket.commented.payload` and the `&& !event.payload.inbound` guard are **added by PR1 Task 10**. Do **not** add them here. PR3 only adds threading metadata to the *already-guarded* branch. If you are rebased onto PR1, the guard is present; confirm with `grep -n "inbound" apps/api/src/jobs/ticketNotifyWorker.ts` before editing.

- [ ] **Step 1: Write the failing tests** — extend `apps/api/src/jobs/ticketNotifyWorker.test.ts`.

Add the config mock at the top of the file (alongside the existing `vi.mock`s). **It must target `'../config/validate'`** — the module `outboundThreading.ts` actually imports (`'../../config/validate'`), which resolves to the same `apps/api/src/config/validate.ts`; from this test file (in `jobs/`) the specifier is `'../config/validate'`. (Do NOT mock `'../config'` — `ticketNotifyWorker.ts` imports nothing from a `config` module, so that mock would silently no-op and the threading assertions would fail because the helper still sees no domain.)

```typescript
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
```

Add the **threaded comment-reply** test. The ticket row carries `submitterEmail`, `internalNumber: 'T-2026-0001'`, `partnerId: 'p-1'`, `subject: 'printer down'`, `emailThreadKey: null`; the partner row carries `slug: 'acme'`, `settings: {}`:

```typescript
it('threads the outbound public-comment reply (Message-ID/In-Reply-To/Reply-To + subject token)', async () => {
  // selectMock returns the ticket row, then the partner (slug + settings) row (see harness).
  await handleTicketEvent({
    type: 'ticket.commented',
    ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
    payload: { commentId: 'c-9', isPublic: true /* inbound omitted = false */ },
  } as never);

  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const arg = sendEmailMock.mock.calls[0][0];
  expect(arg.to).toBe('jane@x.com');
  expect(arg.subject).toBe('[T-2026-0001] New reply: printer down');
  expect(arg.replyTo).toBe('acme@tickets.example.com');
  expect(arg.headers['Message-ID']).toBe('<ticket-t-1-c-9@tickets.example.com>');
  expect(arg.headers['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
  expect(arg.headers['References']).toBe('<ticket-t-1@tickets.example.com>');
});
```

Add the **un-threaded Resolved** regression test (proves the shared helper does NOT thread the status-changed path):

```typescript
it('does NOT thread the Resolved status-changed email (no headers / no Reply-To / no anchor collision)', async () => {
  // same ticket row (submitterEmail set, emailThreadKey null); no partner select needed.
  await handleTicketEvent({
    type: 'ticket.status_changed',
    ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
    payload: { from: 'open', to: 'resolved', resolutionNote: null },
  } as never);

  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const arg = sendEmailMock.mock.calls[0][0];
  expect(arg.subject).toBe('[T-2026-0001] Resolved: printer down');
  expect(arg.headers).toBeUndefined();   // no Message-ID → no collision with the autoresponse anchor
  expect(arg.replyTo).toBeUndefined();
});
```

> The harness's `selectMock` must return rows in order. The comment-reply test consumes TWO selects (ticket, then partner); the Resolved test consumes ONE (ticket only — no partner lookup happens because `commentId` is absent). Mirror the existing multi-select pattern in this file; if it only stubs one select, switch to a queued-results array (`selectMock.mockResolvedValueOnce(ticketRows).mockResolvedValueOnce(partnerRows)`) and reset it in `beforeEach`.

- [ ] **Step 2: Run — expect FAIL** (no `headers`/`replyTo`, subject lacks token):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.test.ts -t "threads\|Resolved" --pool=forks
```

- [ ] **Step 3: Carry threading fields on `EmailPayload`**

In `apps/api/src/jobs/ticketNotifyWorker.ts`, extend the `EmailPayload` interface (~line 45-50):

```typescript
interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  bestEffort?: boolean;
  replyTo?: string;
  headers?: Record<string, string>;
}
```

- [ ] **Step 4: Add the import and make `collectRequesterEmail` thread ONLY when a `commentId` is passed**

Extend the **existing** line-31 import (do not add a second import statement from `'../db/schema'` — the worker already imports `tickets, userNotifications, users` from there; `no-duplicate-imports` would flag a second line):

```typescript
import { partners, tickets, userNotifications, users } from '../db/schema';
```

Add the threading-helper import alongside the other `../services/*` imports (e.g. after the `emailLayout` import ~line 33):

```typescript
import { buildThreadingHeaders, ticketThreadAnchor, partnerInboundAddress } from '../services/inboundEmail/outboundThreading';
```

Change `collectRequesterEmail` (~line 117-137) to optionally accept a `commentId`. When `commentId` is **absent** (the Resolved path) the function behaves exactly as today (no Reply-To, no headers, no anchor stamp). When present (the comment path) it threads:

```typescript
async function collectRequesterEmail(
  event: TicketEvent,
  bodyHtml: string,
  subjectPrefix: string,
  commentId?: string,        // present → thread this email; absent → legacy un-threaded behavior
): Promise<EmailPayload[]> {
  // Pre-commit emission contract: ticket may not be visible yet — throw to trigger retry.
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }
  if (!ticket.submitterEmail) return [];

  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Un-threaded path (e.g. ticket.status_changed 'Resolved'): unchanged from today.
  if (!commentId) {
    return [{
      to: ticket.submitterEmail,
      subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
      html: bodyHtml,
    }];
  }

  // Threaded path (Phase 4 §5): partner inbound address as Reply-To; deterministic
  // Message-ID/In-Reply-To/References so the requester's client threads the reply.
  let replyTo: string | undefined;
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    const override = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string } } }
      | undefined)?.ticketing?.inbound?.address;
    if (slug) replyTo = partnerInboundAddress(slug, override) ?? undefined;
  }

  const built = buildThreadingHeaders({ ticketId: ticket.id, commentId });
  const headers = Object.keys(built).length > 0 ? built : undefined;

  // Stamp the thread anchor onto the ticket the first time so inbound replies match PR1's resolver.
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor && !ticket.emailThreadKey) {
    await db.update(tickets).set({ emailThreadKey: anchor }).where(eq(tickets.id, ticket.id));
  }

  return [{
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml,
    replyTo,
    headers,
  }];
}
```

In the `ticket.commented` branch (~line 204-213) pass the comment id (the `&& !event.payload.inbound` guard is PR1's — leave it):

```typescript
      case 'ticket.commented': {
        if (event.payload.isPublic && !event.payload.inbound) {
          emailPayloads = await collectRequesterEmail(
            event,
            '<p>Your ticket has a new reply. Sign in to the portal to view it.</p>',
            'New reply',
            event.payload.commentId,
          );
        }
        return;
      }
```

Leave the `ticket.status_changed` branch (~line 219-229) **unchanged** — it calls `collectRequesterEmail(event, ..., 'Resolved')` with no fourth argument, so it stays un-threaded.

- [ ] **Step 5: Forward `replyTo`/`headers` in the send loop** (~line 241-252) — both branches:

```typescript
  for (const payload of emailPayloads) {
    const sendArgs = {
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      replyTo: payload.replyTo,
      headers: payload.headers,
    };
    if (payload.bestEffort) {
      try {
        await email.sendEmail(sendArgs);
      } catch (err) {
        console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err);
      }
    } else {
      // Non-best-effort: let throw bubble up so BullMQ can retry.
      await email.sendEmail(sendArgs);
    }
  }
```

- [ ] **Step 6: Run — expect PASS** (the new threading + Resolved tests + the existing notify suite green):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.test.ts --pool=forks
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "feat(ticketing): thread outbound public-comment replies (headers + Reply-To + token); keep Resolved email un-threaded"
```

---

### Task 5: Loop-prevention suppression module

**Files:**
- Create: `apps/api/src/services/inboundEmail/loopPrevention.ts`
- Create: `apps/api/src/services/inboundEmail/loopPrevention.test.ts`

A pure decision function (spec §5) over a `NormalizedInboundEmail` + the resolved inbound domain: returns a reason string when the sender must NOT be autoresponded to, else `null`. The Redis per-sender cap (async) is Task 6; this module is the synchronous header/address rules so each rule is unit-testable. The `self-domain` rule is PR3's autoresponse-time backstop for self-loop mail (the ingest-time DROP is PR1's — see "Self-loop boundary").

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/inboundEmail/loopPrevention.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { autoresponseSuppressionReason } from './loopPrevention';
import type { NormalizedInboundEmail } from './types';

function email(over: Partial<NormalizedInboundEmail>): NormalizedInboundEmail {
  return {
    provider: 'mailgun', providerMessageId: 'm', to: 'acme@tickets.example.com',
    from: 'jane@customer.com', subject: 's', text: 't', attachments: [], raw: {},
    ...over,
  };
}

describe('autoresponseSuppressionReason', () => {
  it('allows a normal human sender (returns null)', () => {
    expect(autoresponseSuppressionReason(email({}), 'tickets.example.com')).toBeNull();
  });

  it('suppresses when Auto-Submitted is present and not "no"', () => {
    expect(autoresponseSuppressionReason(email({ autoSubmitted: 'auto-replied' }), 'tickets.example.com')).toBe('auto-submitted');
    expect(autoresponseSuppressionReason(email({ autoSubmitted: 'no' }), 'tickets.example.com')).toBeNull();
  });

  it('suppresses on Precedence bulk/list/junk', () => {
    for (const p of ['bulk', 'list', 'junk', 'Bulk']) {
      expect(autoresponseSuppressionReason(email({ precedence: p }), 'tickets.example.com')).toBe('precedence');
    }
  });

  it('suppresses no-reply / mailer-daemon / postmaster local-parts', () => {
    expect(autoresponseSuppressionReason(email({ from: 'no-reply@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'noreply@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'MAILER-DAEMON@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'postmaster@x.com' }), 'tickets.example.com')).toBe('system-sender');
  });

  it('suppresses self-loop (sender on our own inbound domain)', () => {
    expect(autoresponseSuppressionReason(email({ from: 'acme@tickets.example.com' }), 'tickets.example.com')).toBe('self-domain');
  });

  it('does not suppress when inbound domain is unconfigured', () => {
    expect(autoresponseSuppressionReason(email({ from: 'acme@tickets.example.com' }), undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/loopPrevention.test.ts --pool=forks
```

- [ ] **Step 3: Implement**

Create `apps/api/src/services/inboundEmail/loopPrevention.ts`:

```typescript
import type { NormalizedInboundEmail } from './types';

const SYSTEM_LOCALPARTS = ['no-reply', 'noreply', 'mailer-daemon', 'postmaster'];
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/**
 * Synchronous loop-prevention rules (spec §5). Returns a reason string when an
 * autoresponse MUST be suppressed for this inbound mail, or null when it's safe
 * to autorespond. The Redis per-sender rate cap is applied separately (Task 6).
 *
 * @param inboundDomain TICKETS_INBOUND_DOMAIN (undefined when unconfigured)
 */
export function autoresponseSuppressionReason(
  n: NormalizedInboundEmail,
  inboundDomain: string | undefined,
): string | null {
  // (1) Auto-Submitted header present and not "no"
  if (n.autoSubmitted && n.autoSubmitted.trim().toLowerCase() !== 'no') {
    return 'auto-submitted';
  }
  // (2) Precedence: bulk / list / junk
  if (n.precedence && BULK_PRECEDENCE.has(n.precedence.trim().toLowerCase())) {
    return 'precedence';
  }
  const from = (n.from || '').trim().toLowerCase();
  const at = from.indexOf('@');
  const localPart = at >= 0 ? from.slice(0, at) : from;
  const senderDomain = at >= 0 ? from.slice(at + 1) : '';
  // (3) system local-parts (no-reply, mailer-daemon, postmaster, …)
  if (SYSTEM_LOCALPARTS.includes(localPart)) {
    return 'system-sender';
  }
  // (4) self-loop backstop: sender on our own inbound domain (PR3 autoresponse-time
  //     guard; PR1 also drops these at ingest — see "Self-loop boundary").
  if (inboundDomain && senderDomain === inboundDomain.trim().toLowerCase()) {
    return 'self-domain';
  }
  return null;
}
```

- [ ] **Step 4: Run — expect PASS:**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/loopPrevention.test.ts --pool=forks
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/loopPrevention.ts apps/api/src/services/inboundEmail/loopPrevention.test.ts
git commit -m "feat(ticketing): autoresponse loop-prevention suppression rules (Phase 4 §5)"
```

---

### Task 6: `ticket.autoresponse` event + `maybeSendAutoresponse` (gate, Redis cap, emit — wired into `createFromEmail`)

**Files:**
- Modify: `apps/api/src/services/ticketEvents.ts` (add `ticket.autoresponse` to the `TicketEvent` union ~line 19-26)
- Create: `apps/api/src/services/inboundEmail/autoresponder.ts`
- Create: `apps/api/src/services/inboundEmail/autoresponder.test.ts`
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts` (call site inside `createFromEmail`, PR1 Task 9)
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.test.ts` (mock `./autoresponder`)

`maybeSendAutoresponse(n, partnerId, ticket)` is the one-time acknowledgement gate. It: (a) re-asserts `ticket.partnerId === partnerId` (spec §6 write-boundary re-assertion — the guards ARE the isolation boundary under system context); (b) reads the partner's `autoresponderEnabled` setting (default `true`); (c) runs `autoresponseSuppressionReason` (Task 5); (d) applies the per-sender Redis cap; and only then (e) emits a `ticket.autoresponse` event so the notify worker sends it (Task 7). Called from PR1's `createFromEmail` **only on the created-for-known-sender path** — never on `quarantined`/`ignored`/`closed-continuation` (spec §5: never autorespond to quarantined/unknown).

> **The `ticket.autoresponse` union member is added in THIS task (Step 1), before the emit (Step 4)** — so there is NO `as never` cast and `tsc --noEmit` stays green at this commit boundary. `TicketEvent` is `TicketEventEnvelope & (union)` — the envelope supplies `ticketId`/`orgId`/`partnerId`/`actorUserId`, so the new union member is **payload-only** (it must NOT redeclare those envelope fields).

- [ ] **Step 1: Add the `ticket.autoresponse` event type**

In `apps/api/src/services/ticketEvents.ts`, add to the `TicketEvent` union (after the `ticket.sla_breached` member ~line 25):

```typescript
  | { type: 'ticket.autoresponse'; payload: { to: string; internalNumber: string | null; subject: string } }
```

(Envelope fields `ticketId`/`orgId`/`partnerId` come from `TicketEventEnvelope` — do not add them to the member.)

- [ ] **Step 2: Write the failing autoresponder test**

Create `apps/api/src/services/inboundEmail/autoresponder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitMock, rateLimiterMock, getRedisMock, partnerSettingsRows } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  rateLimiterMock: vi.fn().mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() }),
  getRedisMock: vi.fn(() => ({})),
  partnerSettingsRows: { value: [{ settings: {} }] as Array<{ settings: unknown }> },
}));

vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(partnerSettingsRows.value) }) }) }) },
}));
vi.mock('../../db/schema', () => ({ partners: { id: 'id', settings: 'settings' } }));

import { maybeSendAutoresponse } from './autoresponder';
import type { NormalizedInboundEmail } from './types';

const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer' };
function n(over: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return { provider: 'mailgun', providerMessageId: 'm', to: 'acme@tickets.example.com', from: 'jane@x.com', subject: 's', text: 't', attachments: [], raw: {}, ...over };
}

beforeEach(() => {
  emitMock.mockClear(); rateLimiterMock.mockClear();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() });
  partnerSettingsRows.value = [{ settings: {} }];
});

describe('maybeSendAutoresponse', () => {
  it('emits a ticket.autoresponse event for an accepted human sender (default enabled)', async () => {
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).toHaveBeenCalledTimes(1);
    const ev = emitMock.mock.calls[0][0];
    expect(ev.type).toBe('ticket.autoresponse');
    expect(ev.ticketId).toBe('t-1');
    expect(ev.orgId).toBe('o-1');
    expect(ev.partnerId).toBe('p-1');
    expect(ev.payload.to).toBe('jane@x.com');
    expect(ev.payload.internalNumber).toBe('T-2026-0001');
    expect(ev.payload.subject).toBe('printer');
  });

  it('THROWS on a partner mismatch (spec §6 write-boundary re-assertion) and never emits', async () => {
    await expect(maybeSendAutoresponse(n(), 'p-OTHER', ticket)).rejects.toThrow(/partner mismatch/);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('suppresses on a loop-prevention rule (Auto-Submitted)', async () => {
    await maybeSendAutoresponse(n({ autoSubmitted: 'auto-replied' }), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('does not emit when autoresponderEnabled is false in partner settings', async () => {
    partnerSettingsRows.value = [{ settings: { ticketing: { inbound: { autoresponderEnabled: false } } } }];
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('respects the per-sender Redis cap (denied → no emit)', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
    expect(rateLimiterMock).toHaveBeenCalledWith(expect.anything(), 'autoresponse:jane@x.com', 1, 86400);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (module not found):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/autoresponder.test.ts --pool=forks
```

- [ ] **Step 4: Implement** (no `as never` — the union member exists from Step 1)

Create `apps/api/src/services/inboundEmail/autoresponder.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { getConfig } from '../../config/validate';
import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';
import { emitTicketEvent } from '../ticketEvents';
import { autoresponseSuppressionReason } from './loopPrevention';
import type { NormalizedInboundEmail } from './types';

interface AutoresponseTicket {
  id: string;
  orgId: string;
  partnerId: string | null;
  internalNumber: string | null;
  subject: string;
}

const AUTORESPONSE_CAP_LIMIT = 1;
const AUTORESPONSE_CAP_WINDOW_SECONDS = 24 * 60 * 60; // 1 per sender per 24h

async function autoresponderEnabled(partnerId: string): Promise<boolean> {
  const rows = await db.select({ settings: partners.settings })
    .from(partners).where(eq(partners.id, partnerId)).limit(1);
  const settings = rows[0]?.settings as
    | { ticketing?: { inbound?: { autoresponderEnabled?: boolean } } }
    | undefined;
  // Default ON when unset (spec §2 config default).
  return settings?.ticketing?.inbound?.autoresponderEnabled !== false;
}

/**
 * One-time acknowledgement gate (spec §5). Emits a `ticket.autoresponse` event
 * (handled by ticketNotifyWorker) only when ALL hold:
 *   - the ticket belongs to the resolved partner (spec §6 re-assertion),
 *   - the partner has autoresponder enabled (default true),
 *   - no loop-prevention rule fires (Auto-Submitted/Precedence/system-sender/self-domain),
 *   - the per-sender Redis cap (1 / 24h) has room.
 * Called ONLY on the created-for-known-sender path — never for quarantined,
 * ignored, or closed-continuation mail (spec §5: never autorespond to unknown).
 */
export async function maybeSendAutoresponse(
  n: NormalizedInboundEmail,
  partnerId: string,
  ticket: AutoresponseTicket,
): Promise<void> {
  // Spec §6: under system context there is no RLS net — re-assert the invariant
  // in app code. A mismatch is a wiring bug; fail loud, never autorespond across tenants.
  if (ticket.partnerId !== partnerId) {
    throw new Error(`partner mismatch — refusing autoresponse (ticket ${ticket.id} partnerId=${ticket.partnerId} resolved=${partnerId})`);
  }

  const reason = autoresponseSuppressionReason(n, getConfig().TICKETS_INBOUND_DOMAIN);
  if (reason) {
    console.info('[InboundEmail] autoresponse suppressed', { reason, from: n.from, ticketId: ticket.id });
    return;
  }
  if (!(await autoresponderEnabled(partnerId))) {
    console.info('[InboundEmail] autoresponse suppressed', { reason: 'disabled', from: n.from, ticketId: ticket.id });
    return;
  }

  const cap = await rateLimiter(getRedis(), `autoresponse:${n.from}`, AUTORESPONSE_CAP_LIMIT, AUTORESPONSE_CAP_WINDOW_SECONDS);
  if (!cap.allowed) {
    console.info('[InboundEmail] autoresponse suppressed', { reason: 'rate-capped', from: n.from, ticketId: ticket.id });
    return;
  }

  await emitTicketEvent({
    type: 'ticket.autoresponse',
    ticketId: ticket.id,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId,
    payload: {
      to: n.from,
      internalNumber: ticket.internalNumber,
      subject: ticket.subject,
    },
  });
}
```

- [ ] **Step 5: Run the autoresponder unit test + typecheck — expect PASS / clean**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/autoresponder.test.ts --pool=forks
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: unit test PASS **and** `tsc --noEmit` clean (the union member from Step 1 makes the strongly-typed `emitTicketEvent(...)` call legal with no cast). If `tsc` flags `ticket.autoresponse`, you skipped Step 1 — add the union member.

- [ ] **Step 6: Wire into `createFromEmail` (PR1 Task 9) — fresh known-sender path only**

In `apps/api/src/services/inboundEmail/inboundEmailService.ts`, import the gate:

```typescript
import { maybeSendAutoresponse } from './autoresponder';
```

First **confirm PR1's `createFromEmail` signature and return shape** (hard-dependency precondition):

```bash
grep -n "function createFromEmail" apps/api/src/services/inboundEmail/inboundEmailService.ts
grep -n "internalNumber\|return ticket\|\.subject" apps/api/src/services/inboundEmail/inboundEmailService.ts
```

It MUST be `createFromEmail(n, partnerId, orgId, carryThreadKey, priorNumber, submittedBy?)` (see "Hard dependency on PR1"). **If the signature differs, stop and reconcile with PR1 — do not adapt the gate to fire on an unverified path.**

In `createFromEmail`, **only on the known-sender fresh-ticket path** (`submittedBy` supplied AND `priorNumber` null — the closed-continuation call passes `priorNumber` and no `submittedBy`), after the ticket is created and the thread key stamped, read back the **persisted** subject + internalNumber (NOT the raw `n.subject`, which still carries the `[T-...]` token PR1 strips on insert) and call the gate:

```typescript
  // One-time autoresponse — only for accepted known senders on a fresh ticket.
  // Closed-continuation (priorNumber set) and quarantine never reach here.
  if (submittedBy && !priorNumber) {
    // Read the PERSISTED subject (token-stripped by createTicket) + internalNumber.
    // Never use raw n.subject — it may still carry the [T-...] token.
    const persisted = await db
      .select({ internalNumber: tickets.internalNumber, subject: tickets.subject })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    await maybeSendAutoresponse(n, partnerId, {
      id: ticket.id,
      orgId,
      partnerId,
      internalNumber: persisted[0]?.internalNumber ?? null,
      subject: persisted[0]?.subject ?? '',
    });
  }
  return ticket;
```

(`tickets` is already imported in `inboundEmailService.ts` from PR1; `eq` from `drizzle-orm` likewise. If a lint flags an unused import that becomes used here, that's expected.)

- [ ] **Step 7: Keep PR1's dispatch-service suite green** — mock `./autoresponder` so PR1's `created`-path assertions don't now also hit Redis/emit. Add to the top of `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`:

```typescript
vi.mock('./autoresponder', () => ({ maybeSendAutoresponse: vi.fn() }));
```

(If PR1's test already mocks it, skip — do not double-declare.)

- [ ] **Step 8: Run — expect PASS:**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/inboundEmail/inboundEmailService.test.ts src/services/inboundEmail/autoresponder.test.ts --pool=forks
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/ticketEvents.ts apps/api/src/services/inboundEmail/autoresponder.ts apps/api/src/services/inboundEmail/autoresponder.test.ts apps/api/src/services/inboundEmail/inboundEmailService.ts apps/api/src/services/inboundEmail/inboundEmailService.test.ts
git commit -m "feat(ticketing): ticket.autoresponse event + one-time autoresponder gate (partner re-assert + loop-prevention + Redis cap)"
```

---

### Task 7: Autoresponse template + notify-worker send branch

**Files:**
- Create: `apps/api/src/services/inboundEmail/autoresponseTemplate.ts`
- Create: `apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts`
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (new `case 'ticket.autoresponse'` in `handleTicketEvent`)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.test.ts`

The autoresponder (Task 6) emits onto the existing `ticket-events` queue (spec §1 — single outbound worker). The notify worker grows one branch that builds the acknowledgement body (hardcoded template, swappable in PR4), stamps `Auto-Submitted: auto-replied` (loop hygiene), and sets the thread anchor as `Message-ID` so the requester's reply threads. The `ticket.autoresponse` union member was already added in Task 6 Step 1, so the new `case` makes `handleTicketEvent`'s exhaustiveness `default: never` arm satisfied.

> **Subject tokenization** comes solely from the template (`buildAutoresponseEmail`). When `internalNumber` is present (the happy path — a `source:'email'` ticket always has one by the time the autoresponse fires) the subject carries `[T-YYYY-NNNN]`; when null it degrades to a token-less subject. This matches spec §5's token requirement for the real path and is a safe fallback otherwise.

- [ ] **Step 1: Add the template (with tests)**

Create `apps/api/src/services/inboundEmail/autoresponseTemplate.ts`:

```typescript
import { escapeHtml } from '../emailLayout';

/** Hardcoded v1 acknowledgement (spec §5). PR4 swaps this for a partner-branded
 *  template; keep the signature stable so the notify-worker branch is unchanged. */
export function buildAutoresponseEmail(args: { internalNumber: string | null; subject: string }): { subject: string; html: string } {
  const label = args.internalNumber ?? 'your request';
  const tokenPrefix = args.internalNumber ? `[${args.internalNumber}] ` : '';
  return {
    subject: `${tokenPrefix}We received your request: ${args.subject}`,
    html:
      `<p>Thanks — we've received your request and opened ticket <strong>${escapeHtml(label)}</strong>.</p>` +
      `<p>Reply to this email to add more detail; our team will follow up.</p>`,
  };
}
```

Create `apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildAutoresponseEmail } from './autoresponseTemplate';

describe('buildAutoresponseEmail', () => {
  it('includes the ticket token in subject and body', () => {
    const m = buildAutoresponseEmail({ internalNumber: 'T-2026-0001', subject: 'printer down' });
    expect(m.subject).toBe('[T-2026-0001] We received your request: printer down');
    expect(m.html).toContain('T-2026-0001');
  });
  it('degrades gracefully without an internal number (token-less subject)', () => {
    const m = buildAutoresponseEmail({ internalNumber: null, subject: 'printer' });
    expect(m.subject).toBe('We received your request: printer');
    expect(m.html).toContain('your request');
  });
});
```

- [ ] **Step 2: Add the failing notify-worker autoresponse test** — extend `apps/api/src/jobs/ticketNotifyWorker.test.ts` (the `vi.mock('../config/validate', …)` added in Task 4 already supplies the domain):

```typescript
it('sends a threaded, Auto-Submitted autoresponse on ticket.autoresponse', async () => {
  // selectMock returns the ticket row { id:'t-1', partnerId:'p-1', settings:{} } then partner { slug:'acme', settings:{} }
  await handleTicketEvent({
    type: 'ticket.autoresponse',
    ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
    payload: { to: 'jane@x.com', internalNumber: 'T-2026-0001', subject: 'printer down' },
  } as never);

  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const arg = sendEmailMock.mock.calls[0][0];
  expect(arg.to).toBe('jane@x.com');
  expect(arg.subject).toBe('[T-2026-0001] We received your request: printer down');
  expect(arg.replyTo).toBe('acme@tickets.example.com');
  expect(arg.headers['Auto-Submitted']).toBe('auto-replied');
  expect(arg.headers['Message-ID']).toBe('<ticket-t-1@tickets.example.com>');
});
```

- [ ] **Step 3: Run — expect FAIL** (no `ticket.autoresponse` branch):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.test.ts -t autoresponse src/services/inboundEmail/autoresponseTemplate.test.ts --pool=forks
```

- [ ] **Step 4: Add the notify-worker branch**

In `apps/api/src/jobs/ticketNotifyWorker.ts`, add the import (alongside the Task 4 threading import):

```typescript
import { buildAutoresponseEmail } from '../services/inboundEmail/autoresponseTemplate';
```

Add a collector near `collectRequesterEmail`. It reuses the same partner-address derivation (slug + settings override) as Task 4:

```typescript
async function collectAutoresponse(
  event: Extract<TicketEvent, { type: 'ticket.autoresponse' }>,
): Promise<EmailPayload[]> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }
  const tpl = buildAutoresponseEmail({
    internalNumber: event.payload.internalNumber,
    subject: event.payload.subject,
  });

  let replyTo: string | undefined;
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    const override = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string } } }
      | undefined)?.ticketing?.inbound?.address;
    if (slug) replyTo = partnerInboundAddress(slug, override) ?? undefined;
  }

  // Anchor as Message-ID so the requester's reply threads; Auto-Submitted for loop hygiene.
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor) headers['Message-ID'] = anchor;

  return [{ to: event.payload.to, subject: tpl.subject, html: tpl.html, replyTo, headers, bestEffort: true }];
}
```

Add the `case` in `handleTicketEvent`'s switch (alongside the others):

```typescript
      case 'ticket.autoresponse': {
        emailPayloads = await collectAutoresponse(event);
        return;
      }
```

- [ ] **Step 5: Run — expect PASS** (notify suite + template + autoresponder still green):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.test.ts src/services/inboundEmail/autoresponseTemplate.test.ts src/services/inboundEmail/autoresponder.test.ts --pool=forks
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/inboundEmail/autoresponseTemplate.ts apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "feat(ticketing): threaded Auto-Submitted autoresponse send branch + template"
```

---

### Task 8: Internal-note leak regression on the outbound composer

**Files:**
- Create: `apps/api/src/jobs/ticketNotifyWorker.leak.test.ts`

Spec §6 + §9: an internal note (`is_public = false`) must NEVER appear in an outbound email or autoresponse. This regression has teeth: it seeds a **real private `ticket_comment` row whose `content` IS the secret**, then drives every email-producing branch and asserts no send body or subject contains it. That way, if a future change starts threading comment *content* into the outbound body, the test catches the leak (the prior version asserted only on inputs the test itself controlled, which was a no-op).

> This is a **mocked-DB** regression (consistent with `ticketNotifyWorker.test.ts`'s harness). The seeded "comment row" is what the mocked `db.select(...)` returns when the composer (or a future regression) looks up comment content; the secret is the `content` value. The point: even though today's composer never reads that row, the test makes the secret *reachable* through the comment-lookup path so a regression that starts reading it fails loudly.

- [ ] **Step 1: Write the regression test**

Create `apps/api/src/jobs/ticketNotifyWorker.leak.test.ts` (reuse the harness/mocks shape from `ticketNotifyWorker.test.ts` — copy its hoisted mocks block + the `vi.mock('../config/validate', …)` added in Task 4). Seed a private comment row carrying the secret as its `content`, and make the mocked `db.select` for `ticket_comments` return it:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
// ... copy the hoisted mock block + vi.mock(...) calls from ticketNotifyWorker.test.ts,
//     including vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) })) ...
import { handleTicketEvent } from './ticketNotifyWorker';

const SECRET = 'INTERNAL: customer is a flight risk, do not disclose';

// A real private comment row for ticket t-1 whose CONTENT is the secret. The
// mocked db must return this for a ticket_comments lookup so that if any branch
// ever threads comment content into the body, the secret would leak — and fail.
const PRIVATE_COMMENT_ROW = {
  id: 'c-secret', ticketId: 't-1', isPublic: false,
  authorType: 'internal', content: SECRET,
};

describe('outbound composer never leaks an internal note (spec §6/§9)', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
    // configure getEmailServiceMock → { sendEmail: sendEmailMock }
    // configure selectMock so a ticket lookup returns the ticket row (submitterEmail set,
    //   subject WITHOUT the secret, internalNumber 'T-2026-0001', partnerId 'p-1'),
    //   a partner lookup returns { slug:'acme', settings:{} },
    //   and a ticket_comments lookup returns [PRIVATE_COMMENT_ROW].
  });

  it('does NOT email the requester for a private (is_public=false) comment', async () => {
    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      payload: { commentId: 'c-secret', isPublic: false },
    } as never);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('no outbound email body ever contains the private comment content', async () => {
    // Drive every email-producing branch (public comment, resolved, autoresponse).
    // The PRIVATE_COMMENT_ROW (content = SECRET) is reachable via the comment lookup,
    // so a regression that threads comment content into the body would leak it here.
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      payload: { commentId: 'c-secret', isPublic: true },
    } as never);
    await handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      payload: { from: 'open', to: 'resolved', resolutionNote: null },
    } as never);
    await handleTicketEvent({
      type: 'ticket.autoresponse', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      payload: { to: 'jane@x.com', internalNumber: 'T-2026-0001', subject: 'printer' },
    } as never);

    expect(sendEmailMock).toHaveBeenCalled();   // the public branches DID send…
    for (const call of sendEmailMock.mock.calls) {
      const { html, subject } = call[0];
      expect(html).not.toContain(SECRET);       // …but none carried the secret
      expect(subject).not.toContain(SECRET);
    }
  });
});
```

> Harness notes: the ticket-row mock must include `submitterEmail` (so the public branches attempt a send) and a `subject` that does NOT contain `SECRET` (so a pass proves the body, not the subject, is clean). The `ticket_comments` mock returning `PRIVATE_COMMENT_ROW` is the load-bearing part — it makes the secret reachable through the comment-lookup path. If the harness keys selects by table, route the `ticket_comments` select to `[PRIVATE_COMMENT_ROW]`; if it queues results, enqueue it after the ticket/partner rows for the branches that look it up.

- [ ] **Step 2: Run — expect PASS** (the composer never reads comment content into the body, so the secret never leaks):

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.leak.test.ts --pool=forks
```

> If test 1 unexpectedly FAILS (a send happens for `isPublic:false`), that is a real leak — fix the `ticket.commented` branch guard (`event.payload.isPublic` must be the gate) before proceeding; do not weaken the test. If test 2 FAILS, a branch is threading comment content into the body — that is the exact regression this test exists to catch; fix the composer, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.leak.test.ts
git commit -m "test(ticketing): internal-note leak regression — seeds a private comment with secret content (§6/§9)"
```

---

### Task 9: End-to-end outbound integration test (real driver)

**Files:**
- Create: `apps/api/src/services/inboundEmail/outbound.integration.test.ts`

The unit tests mock the email service + Redis. This proves the wired path against a real DB under the worker's actual system context: a created `source:'email'` ticket emits `ticket.autoresponse`, and the notify worker composes a threaded, `Auto-Submitted` send; a private comment never emails. Email is mocked at the transport boundary (`getEmailService`) so no real mail leaves; everything below it is real (DB reads, partner slug + settings override, helper output). `getConfig().TICKETS_INBOUND_DOMAIN` must be set in the test env (set `process.env.TICKETS_INBOUND_DOMAIN` before importing modules, or via the integration env file) so the helpers produce headers.

- [ ] **Step 1: Write the test**

Create `apps/api/src/services/inboundEmail/outbound.integration.test.ts`. Seed (system context) a partner with a known `slug` + `settings: {}` + an org + a portal user. Then:

1. **autoresponse end-to-end:** run `withSystemDbAccessContext(() => processInboundEmail(n))` for an email from the known portal user addressed to `{slug}@TICKETS_INBOUND_DOMAIN`. Assert a `source:'email'` ticket exists, then drive `handleTicketEvent` for the emitted `ticket.autoresponse` (capture it off the mocked queue, or construct the event from the created ticket's `internalNumber`/`subject`) and assert the captured `sendEmail` args carry `Auto-Submitted: auto-replied`, the `[T-...]` subject token, `replyTo` = `{slug}@TICKETS_INBOUND_DOMAIN`, and `Message-ID` = `<ticket-{id}@TICKETS_INBOUND_DOMAIN>`.
2. **loop suppression:** repeat with `autoSubmitted: 'auto-replied'` on the inbound → NO `ticket.autoresponse` emitted (assert via the `emitTicketEvent` spy / no autoresponse send).
3. **self-hosted Reply-To override:** seed a second partner whose `settings.ticketing.inbound.address = 'support@helpdesk.theirmsp.com'`; drive its autoresponse and assert `replyTo === 'support@helpdesk.theirmsp.com'` (override wins over the derived default).
4. **threaded reply:** post a public technician comment on the created ticket, emit `ticket.commented` (isPublic, not inbound), and assert the requester send carries the comment `Message-ID` + `In-Reply-To` = the ticket anchor, and the ticket's `email_thread_key` was stamped to `<ticket-{id}@TICKETS_INBOUND_DOMAIN>`.
5. **leak:** a private (`is_public=false`) comment emits no requester email.

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/services/inboundEmail/outbound.integration.test.ts
```

Expected: PASS. **Confirm `getEmailService` is mocked** so no real SMTP/Mailgun/Resend call is attempted (assert via the spy, not a live transport).

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/inboundEmail/outbound.integration.test.ts
git commit -m "test(ticketing): outbound threading + autoresponder + loop-prevention + Reply-To override (real driver)"
```

---

### Task 10: Final verification + PR

- [ ] **Step 1: Typecheck + affected tests**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/email.headers.test.ts \
  src/services/inboundEmail/outboundThreading.test.ts \
  src/services/inboundEmail/loopPrevention.test.ts \
  src/services/inboundEmail/autoresponder.test.ts \
  src/services/inboundEmail/autoresponseTemplate.test.ts \
  src/services/inboundEmail/inboundEmailService.test.ts \
  src/jobs/ticketNotifyWorker.test.ts \
  src/jobs/ticketNotifyWorker.leak.test.ts \
  --pool=forks
```

Expected: clean typecheck (NO `as never` casts on `emitTicketEvent` — the `ticket.autoresponse` union member exists; `as never` remains only where the *test* harness deliberately type-erases event literals); all new + touched suites pass. (Pre-existing unrelated full-suite failures are known — verify only affected files; see `api_test_suite_parallel_flakiness`.)

- [ ] **Step 2: Confirm no duplication of PR1 surface + correct layering**

```bash
# These must already exist from PR1 — PR3 must NOT redefine them:
grep -n "inbound?: boolean\|inbound:" apps/api/src/services/ticketEvents.ts                                  # PR1 adds inbound? to ticket.commented.payload
grep -n "TICKETS_INBOUND_DOMAIN\|MAILGUN_INBOUND_SIGNING_KEY" apps/api/src/config/validate.ts                # PR1 adds to envSchema
grep -n "export async function processInboundEmail" apps/api/src/services/inboundEmail/inboundEmailService.ts # PR1 owns
# This must exist from PR3 (proves the autoresponse event landed here, not PR1):
grep -n "ticket.autoresponse" apps/api/src/services/ticketEvents.ts apps/api/src/jobs/ticketNotifyWorker.ts
# Sanity: NO forbidden config import anywhere PR3 touched (would not compile):
grep -rn "from '\.\./config'\|from '\.\./\.\./config'" apps/api/src/services/inboundEmail apps/api/src/jobs/ticketNotifyWorker.ts || echo "OK: no nonexistent config singleton import"
```

Expected: the three PR1 greps present (proving PR3 is correctly layered on PR1, not re-adding its surface); `ticket.autoresponse` present in both PR3 files; the forbidden-import grep prints `OK`. If any PR1 grep is missing, **PR1 is not merged — stop and rebase.**

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/ticketing-email-outbound
gh pr create --title "feat(ticketing): Phase 4 outbound threading + autoresponder + loop prevention" --body "$(cat <<'EOF'
Phase 4 PR 3 — outbound half of email-to-ticket. Spec: docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md (D1; §2 inbound-address override; §5 threading/autoresponder/loop-prevention; §6 isolation + internal-note leak; §1 reuse ticketNotifyWorker).

**Depends on PR1 (ingest backend)** — must merge after it.

**What:**
- `SendEmailParams.headers` (flat map) threaded through Resend / SMTP / Mailgun (h: form fields).
- Technician public-comment replies now thread: deterministic Message-ID / In-Reply-To / References (anchored on the ticket), Reply-To = partner inbound address (self-hosted override honored), `[T-YYYY-NNNN]` subject token; thread anchor stamped onto tickets.email_thread_key. The Resolved status-changed email stays un-threaded (no Message-ID collision with the autoresponse anchor).
- One-time autoresponder on email-created tickets for accepted senders only — partner re-assertion guard, gated on partner setting (default on), loop-prevention rules, and a per-sender Redis cap (1 / 24h). Emits a new ticket.autoresponse event handled by the existing ticketNotifyWorker (no second worker, spec §1).
- Loop prevention: Auto-Submitted stamping on every autoresponse + suppression on inbound Auto-Submitted / Precedence bulk|list|junk / no-reply|mailer-daemon|postmaster local-parts / self inbound domain (ingest-time self-loop DROP is PR1's).
- Internal-note leak regression on the outbound composer — seeds a real private comment whose content is the secret and proves no send body carries it.

**Out of scope (other PRs):** inbound webhook/worker/schema (PR1); ingest-time self-loop drop (PR1); Settings UI + review queue (PR4); Model-B custom-domain wizard.

**Tests:** provider header mapping (3 transports); threading helper incl. self-hosted address override; un-threaded Resolved email; loop-prevention rules; autoresponder gate (partner re-assert / settings / suppression / Redis cap); autoresponse template; notify-worker threading + autoresponse branches; internal-note leak regression with seeded secret comment; real-driver outbound integration incl. Reply-To override.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (for the implementer)

- **Config access — the #1 foot-gun.** There is NO `apps/api/src/config.ts` and NO `export const config`. Always `import { getConfig } from '../config/validate'` (jobs/) or `'../../config/validate'` (services/inboundEmail/) and read `getConfig().TICKETS_INBOUND_DOMAIN`. Test mocks stub `getConfig` on `'../config/validate'` / `'../../config/validate'`, never a `config` singleton. `email.ts` is the exception: it reads provider config from `process.env` directly, so its tests set `process.env`.
- **PR1 is a hard prerequisite.** This plan edits `inboundEmailService.ts` (PR1 Task 9), reads the PR1 `ticket.commented` `inbound?` guard, depends on `getConfig().TICKETS_INBOUND_DOMAIN` (PR1 adds the key to `validate.ts`), and keys the autoresponse placement on PR1's exact `createFromEmail(n, partnerId, orgId, carryThreadKey, priorNumber, submittedBy?)` signature. Task 0 + Task 10 Step 2 are the guardrails. Branch from `origin/main` with PR1 merged, or rebase onto PR1's branch.
- **Do NOT re-add PR1 surface.** No schema/migration, no webhook/worker, no `MailgunInboundProvider`, no `resolvePartnerByRecipient`, no `createTicket` `submitterEmail` change, no `inbound?` flag, no ingest-time self-loop drop, no `TICKETS_INBOUND_DOMAIN`/`MAILGUN_INBOUND_SIGNING_KEY` config keys — those are PR1.
- **`ticket.autoresponse` union member lands in Task 6 Step 1, before the emit** — so `tsc --noEmit` is green at every commit boundary and there is no `as never` cast on `emitTicketEvent`. `TicketEvent = TicketEventEnvelope & (union)`, so the member is payload-only (no `ticketId`/`orgId`/`partnerId` redeclaration).
- **Only the comment path threads.** `collectRequesterEmail` threads ONLY when passed a `commentId`. The `ticket.status_changed` ("Resolved") branch calls it without one, so its email is byte-for-byte unchanged from today — no `Message-ID`, hence no collision with the autoresponse's bare-anchor `Message-ID`. Task 4's second test locks this.
- **`Reply-To` goes via the existing `replyTo` param, not `headers`.** Mailgun's `sendViaMailgun` already maps `replyTo` → `h:Reply-To`; Task 2's loop explicitly skips a `reply-to` key in `headers` to avoid double-encoding. Pass the partner address as `payload.replyTo`, never inside `headers`.
- **Reply-To honors the self-hosted override.** `partnerInboundAddress(slug, override)` reads `partners.settings.ticketing.inbound.address` first (spec §2). This must equal whatever PR1's `resolvePartnerByRecipient` accepts as inbound, or the requester's reply won't route back. Task 3 + Task 9 step 3 test the override.
- **Partner re-assertion in the autoresponder.** `maybeSendAutoresponse` throws on `ticket.partnerId !== partnerId` (spec §6 — the guards are the isolation boundary under system context). Cheap, and Task 6's test asserts the throw.
- **Thread anchor format must match PR1's resolver.** PR1's `findTicketInPartner` matches inbound `In-Reply-To`/`References` against `tickets.email_thread_key`. PR3 stamps that column with `<ticket-${ticketId}@${TICKETS_INBOUND_DOMAIN}>` and sets outbound `In-Reply-To`/`References` to the same value. If PR1 stamps `email_thread_key` differently in `createFromEmail`, reconcile the two — the value Task 4 writes and the value PR1's resolver reads must be identical. Confirm with `grep -n "emailThreadKey" apps/api/src/services/inboundEmail/inboundEmailService.ts`.
- **Autoresponse subject uses the PERSISTED subject, never raw `n.subject`.** Task 6 Step 6 reads `tickets.subject`/`tickets.internalNumber` back from the DB after `createTicket` (which strips the `[T-...]` token); raw `n.subject` may still carry the token and is wrong.
- **No duplicate `'../db/schema'` import in the worker.** Extend the existing line-31 import to `{ partners, tickets, userNotifications, users }` — don't add a second import line (`no-duplicate-imports`).
- **`EmailService` export:** Task 1 assumes the class is importable for the provider tests. If `getEmailService` constructs a non-exported class, add `export` to it (cheap, no behavior change).
- **Config env keys:** `TICKETS_INBOUND_DOMAIN` is the only env this PR reads, and PR1 already added it to `apps/api/src/config/validate.ts` + deploy env. Feature degrades closed: `buildThreadingHeaders`/`partnerInboundAddress` return empty/null when unset (no headers, no derived Reply-To — the email still sends, just unthreaded), and `autoresponseSuppressionReason`'s self-domain rule is skipped. A self-hosted `address` override still works with no platform domain. No new deploy-env work in this PR.
- **Per-sender cap vs idempotency:** PR1's `(partner_id, provider_message_id)` uniqueness already blocks re-sending on provider retries of the *same* message. The 1/24h Redis cap (Task 6) is the orthogonal bound on *distinct* messages from a runaway sender — both are needed.

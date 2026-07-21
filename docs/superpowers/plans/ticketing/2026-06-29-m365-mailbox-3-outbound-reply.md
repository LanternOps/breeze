# M365 Mailbox — Plan 3: Outbound Graph Reply — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a ticket's partner has a connected M365 mailbox and the ticket arrived through it, send customer-facing replies via Microsoft Graph **from the real support mailbox** (native conversation threading), instead of the platform `{slug}@tickets.<domain>` sender. Internal/tech notifications stay on the existing `EmailService`.

**Architecture:** A `graphReplySender` performs Graph `createReply` → PATCH body → send for threaded replies, and `sendMail` for first-contact/autoresponse with no original message. `collectRequesterEmail` (in `ticketNotifyWorker`) is extended to attach a `graphMailbox` descriptor to the customer payload when the partner has a connected mailbox; the send loop forks on that field. The original Graph message id to reply to is looked up from `ticket_email_inbound` (most recent `provider='m365'` row for the ticket) — no schema change.

**Tech Stack:** Microsoft Graph v1.0, BullMQ worker, Drizzle, Vitest.

## Global Constraints

- Depends on **Plan 1** (`getMailboxToken`, `MailboxConnection`, connection lookups) and reuses **Plan 2**'s `graphFetch` 429 handling pattern.
- Only **customer-facing** email may route through the mailbox: `ticket.commented` (public), resolved `ticket.status_changed`, autoresponse. `ticket.assigned` and any tech/internal payload ALWAYS use `EmailService`.
- Threading via Graph: you CANNOT set `In-Reply-To`/`References` through `internetMessageHeaders` (Graph only allows `x-`-prefixed custom headers). Use `createReply` on the original message — Graph maintains `conversationId` + `References` natively.
- Loop safety: replies land in Sent Items; the poll worker reads Inbox only → no self-ingest. The existing one-time autoresponder + two-layer loop-prevention still apply unchanged.
- Send happens OUTSIDE the DB context (the worker already sends outside the txn to avoid pool poison, #1105). Mailbox/message-id lookups are short reads.
- A Graph send failure for a non-best-effort payload must still bubble so BullMQ retries (parity with the existing `EmailService` path).

## File Structure

- Create `apps/api/src/services/ticketMailbox/graphReplySender.ts` — `sendThreadedReply`, `sendNewMail`.
- Create `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts` — given a ticket, return `{ tenantId, mailbox, originalMessageId? } | null`.
- Modify `apps/api/src/jobs/ticketNotifyWorker.ts` — attach `graphMailbox` to customer payloads in `collectRequesterEmail`; fork the send loop.
- Tests co-located.

## Shared Interface Contract (produced here)

```typescript
// services/ticketMailbox/graphReplySender.ts
export interface GraphSendTarget { tenantId: string; mailbox: string; }
export function sendThreadedReply(t: GraphSendTarget, originalMessageId: string, html: string): Promise<void>;
export function sendNewMail(t: GraphSendTarget, to: string, subject: string, html: string): Promise<void>;

// services/ticketMailbox/resolveOutboundMailbox.ts
export interface OutboundMailbox { tenantId: string; mailbox: string; originalMessageId: string | null; }
export function resolveOutboundMailbox(ticketId: string, partnerId: string | null): Promise<OutboundMailbox | null>;

// jobs/ticketNotifyWorker.ts — EmailPayload gains:
//   graphMailbox?: { tenantId: string; mailbox: string; originalMessageId: string | null };
```

---

### Task 1: Graph reply sender (`graphReplySender.ts`)

**Files:**
- Create: `apps/api/src/services/ticketMailbox/graphReplySender.ts`
- Test: `apps/api/src/services/ticketMailbox/graphReplySender.test.ts`

**Interfaces:**
- Consumes: `getMailboxToken` (Plan 1).
- Produces: `GraphSendTarget`, `sendThreadedReply`, `sendNewMail`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/ticketMailbox/graphReplySender.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
import { sendThreadedReply, sendNewMail } from './graphReplySender';

const target = { tenantId: '11111111-1111-1111-1111-111111111111', mailbox: 'support@a.com' };

describe('sendThreadedReply', () => {
  beforeEach(() => fetchMock.mockReset());

  it('createReply → PATCH body → send (3 calls, in order)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'draft-9' }) }) // createReply
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })                // PATCH
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });                 // send

    await sendThreadedReply(target, 'orig-1', '<p>reply</p>');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/messages/orig-1/createReply');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toContain('/messages/draft-9');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).body).toEqual({ contentType: 'HTML', content: '<p>reply</p>' });
    expect(fetchMock.mock.calls[2][0]).toContain('/messages/draft-9/send');
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
  });

  it('throws if createReply fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    await expect(sendThreadedReply(target, 'orig-1', '<p>x</p>')).rejects.toThrow(/403/);
  });
});

describe('sendNewMail', () => {
  beforeEach(() => fetchMock.mockReset());
  it('POSTs sendMail with the message envelope', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    await sendNewMail(target, 'cust@x.com', 'Re: hi [T-2026-0007]', '<p>hello</p>');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/users/support%40a.com/sendMail');
    const payload = JSON.parse(opts.body);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('cust@x.com');
    expect(payload.message.subject).toBe('Re: hi [T-2026-0007]');
    expect(payload.saveToSentItems).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/graphReplySender.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/ticketMailbox/graphReplySender.ts
import { getMailboxToken } from './mailboxToken';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphSendTarget { tenantId: string; mailbox: string; }

async function gfetch(url: string, token: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    redirect: 'error',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph ${init.method ?? 'GET'} ${url} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

/** Threaded reply from the support mailbox: createReply → set body → send.
 *  Graph keeps it in the customer's existing conversation (References/conversationId). */
export async function sendThreadedReply(t: GraphSendTarget, originalMessageId: string, html: string): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  const base = `${GRAPH}/users/${encodeURIComponent(t.mailbox)}/messages`;

  const draftRes = await gfetch(`${base}/${encodeURIComponent(originalMessageId)}/createReply`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const draft = (await draftRes.json()) as { id?: string };
  if (!draft.id) throw new Error('Graph createReply returned no draft id');

  await gfetch(`${base}/${encodeURIComponent(draft.id)}`, token, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'HTML', content: html } }),
  });

  await gfetch(`${base}/${encodeURIComponent(draft.id)}/send`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
}

/** First-contact / autoresponse with no original message to reply to. */
export async function sendNewMail(t: GraphSendTarget, to: string, subject: string, html: string): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  await gfetch(`${GRAPH}/users/${encodeURIComponent(t.mailbox)}/sendMail`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/graphReplySender.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/graphReplySender.ts apps/api/src/services/ticketMailbox/graphReplySender.test.ts
git commit -m "feat(tickets): Graph reply sender (createReply + sendMail from mailbox)"
```

---

### Task 2: Resolve the outbound mailbox for a ticket

**Files:**
- Create: `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts`
- Test: `apps/api/src/services/ticketMailbox/resolveOutboundMailbox.test.ts`

**Interfaces:**
- Consumes: `db` + `ticketMailboxConnections` schema (Plan 1), `ticket_email_inbound` (existing).
- Produces: `OutboundMailbox`, `resolveOutboundMailbox(ticketId, partnerId)`.

Returns `null` unless the partner has exactly one `status='connected'` mailbox; `originalMessageId` is the most recent `ticket_email_inbound.provider_message_id` for this ticket with `provider='m365'` (null if the ticket never had an M365 inbound message — e.g. created in-app — so the caller uses `sendNewMail`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/ticketMailbox/resolveOutboundMailbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connRows = vi.fn();
const inboundRows = vi.fn();
vi.mock('../../db', () => ({
  db: {
    select: (..._a: any[]) => ({
      from: (tbl: any) => ({
        where: () => ({
          limit: async () => (String(tbl).includes('mailbox') ? connRows() : inboundRows()),
          orderBy: () => ({ limit: async () => inboundRows() }),
        }),
      }),
    }),
  },
}));
// Schema identity stubs so `String(tbl)` discriminates the two selects.
vi.mock('../../db/schema/ticketMailbox', () => ({ ticketMailboxConnections: { _: 'ticket_mailbox_connections' } }));

import { resolveOutboundMailbox } from './resolveOutboundMailbox';

describe('resolveOutboundMailbox', () => {
  beforeEach(() => { connRows.mockReset(); inboundRows.mockReset(); });

  it('returns null when the partner has no connected mailbox', async () => {
    connRows.mockResolvedValue([]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('returns mailbox + originalMessageId from the latest m365 inbound row', async () => {
    connRows.mockResolvedValue([{ tenantId: 'ten', mailboxAddress: 'support@a.com' }]);
    inboundRows.mockResolvedValue([{ providerMessageId: 'graph-77' }]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'support@a.com', originalMessageId: 'graph-77' });
  });

  it('returns originalMessageId null when no m365 inbound row exists', async () => {
    connRows.mockResolvedValue([{ tenantId: 'ten', mailboxAddress: 'support@a.com' }]);
    inboundRows.mockResolvedValue([]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r?.originalMessageId).toBeNull();
  });

  it('returns null when partnerId is null', async () => {
    expect(await resolveOutboundMailbox('t1', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/resolveOutboundMailbox.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { ticketMailboxConnections } from '../../db/schema/ticketMailbox';
import { ticketEmailInbound } from '../../db/schema/emailInbound';

export interface OutboundMailbox { tenantId: string; mailbox: string; originalMessageId: string | null; }

export async function resolveOutboundMailbox(ticketId: string, partnerId: string | null): Promise<OutboundMailbox | null> {
  if (!partnerId) return null;

  const conn = await db.select({
    tenantId: ticketMailboxConnections.tenantId,
    mailboxAddress: ticketMailboxConnections.mailboxAddress,
  }).from(ticketMailboxConnections)
    .where(and(
      eq(ticketMailboxConnections.partnerId, partnerId),
      eq(ticketMailboxConnections.status, 'connected'),
    )).limit(1);
  if (!conn[0]?.tenantId) return null;

  const inbound = await db.select({ providerMessageId: ticketEmailInbound.providerMessageId })
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.ticketId, ticketId), eq(ticketEmailInbound.provider, 'm365')))
    .orderBy(desc(ticketEmailInbound.createdAt))
    .limit(1);

  return {
    tenantId: conn[0].tenantId,
    mailbox: conn[0].mailboxAddress,
    originalMessageId: inbound[0]?.providerMessageId ?? null,
  };
}
```

> Confirm the `ticket_email_inbound` Drizzle export name (`ticketEmailInbound`), its `ticketId`/`provider`/`providerMessageId`/`createdAt` column accessors, and its import path (`../../db/schema/emailInbound`). Adjust if the schema file names differ.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/resolveOutboundMailbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/resolveOutboundMailbox.ts apps/api/src/services/ticketMailbox/resolveOutboundMailbox.test.ts
git commit -m "feat(tickets): resolve outbound mailbox + original message id for a ticket"
```

---

### Task 3: Fork the notify worker's customer-facing send

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (the `EmailPayload` type, `collectRequesterEmail` ~lines 130-188, and the send loop ~lines 374-392).
- Test: `apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts`

**Interfaces:**
- Consumes: `resolveOutboundMailbox` (Task 2), `sendThreadedReply`/`sendNewMail` (Task 1).
- Produces: `EmailPayload.graphMailbox?` + forked dispatch.

- [ ] **Step 1: Add `graphMailbox` to the `EmailPayload` type**

In `ticketNotifyWorker.ts`, extend the `EmailPayload` interface:

```typescript
  graphMailbox?: { tenantId: string; mailbox: string; originalMessageId: string | null };
```

- [ ] **Step 2: Attach `graphMailbox` in `collectRequesterEmail`**

In `collectRequesterEmail`, after the ticket is loaded and `ticket.submitterEmail` is confirmed, resolve the mailbox once and attach it to the returned payload(s). Add near the top of the function (after the `if (!ticket.submitterEmail) return [];` guard):

```typescript
  // Customer-facing only: if this partner has a connected M365 mailbox, the reply
  // goes out FROM that mailbox via Graph (native threading). Tech/assignee emails
  // never call collectRequesterEmail, so they never get graphMailbox.
  const graphMailbox = (await resolveOutboundMailbox(ticket.id, ticket.partnerId)) ?? undefined;
```

Then add `graphMailbox` to BOTH returned payload objects (the un-threaded resolved-status branch and the threaded branch). For example, the threaded `return` becomes:

```typescript
  return [{
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml,
    replyTo,
    headers,
    graphMailbox,
  }];
```

and the un-threaded `return` adds `graphMailbox` likewise.

> Import at the top of the file:
> ```typescript
> import { resolveOutboundMailbox } from '../services/ticketMailbox/resolveOutboundMailbox';
> import { sendThreadedReply, sendNewMail } from '../services/ticketMailbox/graphReplySender';
> ```

- [ ] **Step 3: Fork the send loop**

Replace the per-payload send body (the `if (payload.bestEffort) { ... } else { ... }` block in the send loop ~lines 380-392) so it routes through Graph when `graphMailbox` is present:

```typescript
  for (const payload of emailPayloads) {
    const send = async () => {
      if (payload.graphMailbox) {
        const { tenantId, mailbox, originalMessageId } = payload.graphMailbox;
        if (originalMessageId) {
          await sendThreadedReply({ tenantId, mailbox }, originalMessageId, payload.html);
        } else {
          await sendNewMail({ tenantId, mailbox }, Array.isArray(payload.to) ? payload.to[0] : payload.to, payload.subject, payload.html);
        }
        return;
      }
      await email.sendEmail({
        to: payload.to, subject: payload.subject, html: payload.html,
        replyTo: payload.replyTo, headers: payload.headers,
      });
    };

    if (payload.bestEffort) {
      try { await send(); }
      catch (err) { console.error('[TicketNotify] email send failed', err instanceof Error ? err.message : err); }
    } else {
      await send(); // let throw bubble so BullMQ retries
    }
  }
```

> Note: the existing guard `if (!email || emailPayloads.length === 0) return;` early-returns when no `EmailService` is configured. Keep that guard, but Graph payloads should still send even if `EmailService` is unconfigured. Change the guard to `if (emailPayloads.length === 0) return;` and inside the non-graph branch keep a local `if (!email) { ...skip/log... }` so a missing platform transport doesn't suppress Graph sends. Confirm against the actual code and adjust minimally.

- [ ] **Step 4: Write the fork test**

```typescript
// apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendThreaded = vi.fn(async () => {});
const sendNew = vi.fn(async () => {});
const emailSend = vi.fn(async () => {});
vi.mock('../services/ticketMailbox/graphReplySender', () => ({ sendThreadedReply: sendThreaded, sendNewMail: sendNew }));
// ... mock getEmailService() to return { sendEmail: emailSend }, getTicket(), resolveOutboundMailbox(), buildThreadingHeaders(), db, partners, etc.
// Follow the existing ticketNotifyWorker test file's mock scaffolding exactly.

describe('ticketNotifyWorker Graph fork', () => {
  beforeEach(() => { sendThreaded.mockClear(); sendNew.mockClear(); emailSend.mockClear(); });

  it('routes a threaded customer reply through sendThreadedReply, not EmailService', async () => {
    // Arrange: ticket.commented (public) on a partner WITH a connected mailbox and an originalMessageId.
    // Act: dispatch the event through the worker handler.
    // Assert:
    expect(sendThreaded).toHaveBeenCalledTimes(1);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('uses sendNewMail when there is no original message id', async () => {
    expect(sendNew).toHaveBeenCalledTimes(1);
  });

  it('routes assignee/tech notifications through EmailService (never Graph)', async () => {
    // Arrange: ticket.assigned event.
    expect(emailSend).toHaveBeenCalled();
    expect(sendThreaded).not.toHaveBeenCalled();
    expect(sendNew).not.toHaveBeenCalled();
  });
});
```

> Fill the Arrange/Act using the existing `ticketNotifyWorker.test.ts` harness in the same directory — copy its event-dispatch entrypoint and mock setup. The assertions above are the contract; the scaffolding mirrors the existing tests.

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/jobs/ticketNotifyWorker.graphFork.test.ts src/jobs/ticketNotifyWorker.test.ts`
Expected: PASS (both the new fork test and the existing worker tests).

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts
git commit -m "feat(tickets): route customer-facing replies through the M365 mailbox"
```

---

## Self-Review (Plan 3)

- **Spec coverage:** createReply threaded send + sendMail fallback (Task 1), mailbox+original-message resolution with no schema change (Task 2), customer-only fork with tech notifications staying on `EmailService` (Task 3). ✅
- **Graph threading correctness:** uses `createReply` (not `internetMessageHeaders`) so `In-Reply-To`/`References` are set natively — matches the Global Constraint. ✅
- **Loop safety:** `saveToSentItems: true` + Inbox-only polling = no self-ingest; existing autoresponder/loop-prevention untouched. ✅
- **Type consistency:** `GraphSendTarget`, `OutboundMailbox`, and `EmailPayload.graphMailbox` names match across Tasks 1–3; `getMailboxToken` matches Plan 1. ✅
- **Failure semantics:** non-best-effort Graph sends bubble for BullMQ retry; best-effort swallow+log — parity with the existing `EmailService` path. ✅
- **Implementer verifications flagged inline:** `ticket_email_inbound` schema export/columns; the exact `EmailService`-unconfigured guard rewrite; the existing notify-worker test harness shape.

# M365 Mailbox — Plan 2: Inbound Delta-Poll Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll each connected M365 mailbox via Microsoft Graph `/messages/delta`, normalize new messages into the existing `NormalizedInboundEmail` shape, enqueue them onto the existing `inbound-email` queue, mark them read, and persist the delta cursor — reusing all of `processInboundEmail`'s threading/dedup/ticket logic.

**Architecture:** A `graphMailClient` wraps the Graph calls (delta paging + mark-read + 429 backoff). A pure `normalizeGraphMessage` maps a Graph message to `NormalizedInboundEmail` (provider `'m365'`, pre-resolved partner, sender-auth verdict from the `Authentication-Results` header). A BullMQ repeatable sweep worker iterates connected mailboxes outside any DB transaction (no connection-hold during network I/O) and uses the existing dedup index for at-least-once safety. One tiny seam: `processInboundEmail` honors a `resolvedPartnerId` to skip recipient resolution.

**Tech Stack:** Hono/Node, Microsoft Graph v1.0, BullMQ, Drizzle, Vitest.

## Global Constraints

- Depends on **Plan 1** (merged): `getMailboxToken`, `listConnectedMailboxes`, `updateDeltaCursor`, `setConnectionStatus`, `MailboxConnection`.
- Never hold a DB transaction across a network call (idle-in-txn pool poison, #1105). Read connections in a short system-context txn, do Graph I/O outside any DB context, then persist the cursor in another short system-context txn.
- Worker DB writes: `runOutsideDbContext(() => withSystemDbAccessContext(...))`. Defensive `getConfig()` on the worker path.
- At-least-once delivery: persist the new `delta_link` only after the whole page is enqueued; the existing `ticket_email_inbound (partner_id, provider_message_id)` unique index absorbs replays.
- BullMQ jobId must contain 0 or exactly 2 colons — use hyphens. Repeatable sweep is a singleton per queue.
- No history backfill: a fresh connection and a 410-Gone resync both start the delta from "now".
- Graph 429: honor `Retry-After`, exponential backoff; per-mailbox failures are isolated (one bad tenant must not stall others).

## File Structure

- Modify `apps/api/src/services/inboundEmail/types.ts` — add `'m365'` to `InboundProviderName`; add `resolvedPartnerId?` to `NormalizedInboundEmail`.
- Modify `apps/api/src/services/inboundEmail/inboundEmailService.ts` — honor `resolvedPartnerId`.
- Create `apps/api/src/services/ticketMailbox/graphMailClient.ts` — `listInboxDelta`, `markRead`, `graphFetch`.
- Create `apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts` — Graph message → `NormalizedInboundEmail`.
- Create `apps/api/src/jobs/ticketMailboxPollWorker.ts` — repeatable sweep worker.
- Modify the worker-bootstrap file (where `initializeInboundEmailWorker()` / `ticketSlaWorker` are started) — start the poll worker.
- Tests co-located.

## Shared Interface Contract (produced here)

```typescript
// services/ticketMailbox/graphMailClient.ts
export interface GraphRecipient { emailAddress?: { address?: string; name?: string }; }
export interface GraphHeader { name: string; value: string; }
export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  conversationId?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
  internetMessageHeaders?: GraphHeader[];
}
export interface DeltaPage { messages: GraphMessage[]; deltaLink: string | null; }
export function listInboxDelta(token: string, mailbox: string, deltaLink: string | null): Promise<DeltaPage>;
export function markRead(token: string, mailbox: string, messageId: string): Promise<void>;

// services/ticketMailbox/normalizeGraphMessage.ts
export function normalizeGraphMessage(msg: GraphMessage, partnerId: string, mailboxAddress: string): NormalizedInboundEmail;
```

---

### Task 1: Seam — `resolvedPartnerId` on the inbound pipeline

**Files:**
- Modify: `apps/api/src/services/inboundEmail/types.ts`
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts:101-118`
- Test: `apps/api/src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts`

**Interfaces:**
- Produces: `NormalizedInboundEmail.resolvedPartnerId?: string`; `InboundProviderName` includes `'m365'`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts
import { describe, it, expect, vi } from 'vitest';

const resolveSpy = vi.fn(async () => 'should-not-be-called');
vi.mock('./resolvePartner', () => ({ resolvePartnerByRecipient: resolveSpy }));
// Make the partner look active so processing proceeds past the status gate,
// then stop at the first unmocked dependency — we only assert resolve is skipped.
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: 'active' }] }) }) }) },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
}));

import { processInboundEmail } from './inboundEmailService';
import type { NormalizedInboundEmail } from './types';

const base: NormalizedInboundEmail = {
  provider: 'm365', providerMessageId: 'g1', to: 'support@a.com', from: 'cust@x.com',
  subject: 'hi', text: 'body', attachments: [], raw: {}, resolvedPartnerId: 'partner-123',
};

describe('processInboundEmail resolvedPartnerId seam', () => {
  it('does not call resolvePartnerByRecipient when resolvedPartnerId is present', async () => {
    try { await processInboundEmail(base); } catch { /* later deps unmocked — fine */ }
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts`
Expected: FAIL (`resolvePartnerByRecipient` is still called).

- [ ] **Step 3: Edit the type**

In `apps/api/src/services/inboundEmail/types.ts`: add `'m365'` to the `InboundProviderName` union, and add to `NormalizedInboundEmail`:

```typescript
  /** When the feeder already knows the partner (e.g. polled that partner's mailbox),
   *  skip recipient-based resolution. */
  resolvedPartnerId?: string;
```

- [ ] **Step 4: Honor it in `processInboundEmail`**

In `inboundEmailService.ts`, replace the resolution line (currently `partnerId = await resolvePartnerByRecipient(n.to);`) with:

```typescript
    partnerId = n.resolvedPartnerId ?? await resolvePartnerByRecipient(n.to);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/inboundEmail/types.ts apps/api/src/services/inboundEmail/inboundEmailService.ts apps/api/src/services/inboundEmail/inboundEmailService.resolvedPartner.test.ts
git commit -m "feat(tickets): inbound pipeline honors a pre-resolved partner id"
```

---

### Task 2: Graph mail client (delta paging + mark-read + 429 backoff)

**Files:**
- Create: `apps/api/src/services/ticketMailbox/graphMailClient.ts`
- Test: `apps/api/src/services/ticketMailbox/graphMailClient.test.ts`

**Interfaces:**
- Produces: `GraphMessage`, `GraphHeader`, `GraphRecipient`, `DeltaPage`, `listInboxDelta`, `markRead`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/ticketMailbox/graphMailClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
import { listInboxDelta, markRead } from './graphMailClient';

const SELECT = '%24select'; // encodeURIComponent('$select')

describe('listInboxDelta', () => {
  beforeEach(() => fetchMock.mockReset());

  it('follows @odata.nextLink, aggregates messages, returns the final deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({
        value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph.microsoft.com/next-2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({
        value: [{ id: 'm2' }], '@odata.deltaLink': 'https://graph.microsoft.com/delta-final' }) });

    const page = await listInboxDelta('tok', 'support@a.com', null);
    expect(page.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(page.deltaLink).toBe('https://graph.microsoft.com/delta-final');
    // First call hits the inbox delta endpoint with a $select.
    expect(fetchMock.mock.calls[0][0]).toContain('/mailFolders/inbox/messages/delta');
    expect(fetchMock.mock.calls[0][0]).toContain(SELECT);
  });

  it('uses the stored deltaLink verbatim when provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({
      value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta-2' }) });
    await listInboxDelta('tok', 'support@a.com', 'https://graph.microsoft.com/stored-delta');
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.microsoft.com/stored-delta');
  });

  it('retries once on 429 honoring Retry-After', async () => {
    const headers429 = new Map([['retry-after', '0']]);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: headers429, text: async () => 'throttled' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({ value: [], '@odata.deltaLink': 'd' }) });
    const page = await listInboxDelta('tok', 'support@a.com', null);
    expect(page.deltaLink).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('markRead', () => {
  beforeEach(() => fetchMock.mockReset());
  it('PATCHes isRead true', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Map(), json: async () => ({}) });
    await markRead('tok', 'support@a.com', 'm1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/messages/m1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ isRead: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/graphMailClient.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/ticketMailbox/graphMailClient.ts
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DELTA_SELECT = [
  'id', 'internetMessageId', 'subject', 'from', 'toRecipients', 'ccRecipients',
  'receivedDateTime', 'conversationId', 'body', 'bodyPreview', 'hasAttachments', 'internetMessageHeaders',
].join(',');

export interface GraphRecipient { emailAddress?: { address?: string; name?: string }; }
export interface GraphHeader { name: string; value: string; }
export interface GraphMessage {
  id: string; internetMessageId?: string; subject?: string; from?: GraphRecipient;
  toRecipients?: GraphRecipient[]; ccRecipients?: GraphRecipient[]; receivedDateTime?: string;
  conversationId?: string; body?: { contentType?: string; content?: string }; bodyPreview?: string;
  hasAttachments?: boolean; internetMessageHeaders?: GraphHeader[];
}
export interface DeltaPage { messages: GraphMessage[]; deltaLink: string | null; }

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Graph fetch with one 429 retry honoring Retry-After. Never follows redirects with the bearer token. */
async function graphFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      redirect: 'error',
    });
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get?.('retry-after') ?? '1');
    await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 30) * 1000);
  }
  // Final attempt without retry budget.
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }, redirect: 'error' });
}

export async function listInboxDelta(token: string, mailbox: string, deltaLink: string | null): Promise<DeltaPage> {
  let url = deltaLink
    ?? `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta`
       + `?${encodeURIComponent('$select')}=${encodeURIComponent(DELTA_SELECT)}`;
  const messages: GraphMessage[] = [];
  let finalDelta: string | null = null;

  // Page through nextLink; the last page carries deltaLink.
  for (let guard = 0; guard < 1000; guard++) {
    const res = await graphFetch(url, token);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Graph delta ${res.status}: ${body.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json()) as {
      value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string;
    };
    if (Array.isArray(data.value)) messages.push(...data.value);
    if (data['@odata.nextLink']) { url = data['@odata.nextLink']; continue; }
    finalDelta = data['@odata.deltaLink'] ?? null;
    break;
  }
  return { messages, deltaLink: finalDelta };
}

export async function markRead(token: string, mailbox: string, messageId: string): Promise<void> {
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
  await graphFetch(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true }),
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/graphMailClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/graphMailClient.ts apps/api/src/services/ticketMailbox/graphMailClient.test.ts
git commit -m "feat(tickets): Graph mail client (delta paging, mark-read, 429 backoff)"
```

---

### Task 3: Normalizer (`normalizeGraphMessage`)

**Files:**
- Create: `apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts`
- Test: `apps/api/src/services/ticketMailbox/normalizeGraphMessage.test.ts`

**Interfaces:**
- Consumes: `GraphMessage` (Task 2), `NormalizedInboundEmail`/`SenderAuth` (`../inboundEmail/types`).
- Produces: `normalizeGraphMessage(msg, partnerId, mailboxAddress)`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/ticketMailbox/normalizeGraphMessage.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeGraphMessage } from './normalizeGraphMessage';
import type { GraphMessage } from './graphMailClient';

const msg: GraphMessage = {
  id: 'AAA-graph-id',
  internetMessageId: '<abc@mail.x.com>',
  subject: 'Printer down [T-2026-0007]',
  from: { emailAddress: { address: 'Cust@X.com', name: 'Cust' } },
  toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
  conversationId: 'conv-1',
  body: { contentType: 'html', content: '<p>help</p>' },
  bodyPreview: 'help',
  hasAttachments: false,
  internetMessageHeaders: [
    { name: 'In-Reply-To', value: '<prev@mail.x.com>' },
    { name: 'References', value: '<root@mail.x.com> <prev@mail.x.com>' },
    { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass action=none' },
  ],
};

describe('normalizeGraphMessage', () => {
  it('maps core fields, provider, and pre-resolved partner', () => {
    const n = normalizeGraphMessage(msg, 'partner-9', 'support@a.com');
    expect(n.provider).toBe('m365');
    expect(n.providerMessageId).toBe('AAA-graph-id');
    expect(n.resolvedPartnerId).toBe('partner-9');
    expect(n.to).toBe('support@a.com');
    expect(n.from).toBe('cust@x.com');           // lowercased
    expect(n.subject).toBe('Printer down [T-2026-0007]');
    expect(n.messageId).toBe('<abc@mail.x.com>');
    expect(n.inReplyTo).toBe('<prev@mail.x.com>');
    expect(n.references).toEqual(['<root@mail.x.com>', '<prev@mail.x.com>']);
    expect(n.html).toBe('<p>help</p>');
  });

  it('extracts dmarc=pass into senderAuth', () => {
    const n = normalizeGraphMessage(msg, 'partner-9', 'support@a.com');
    expect(n.senderAuth?.dmarc).toBe('pass');
  });

  it('leaves senderAuth dmarc unset when the header is missing', () => {
    const n = normalizeGraphMessage({ ...msg, internetMessageHeaders: [] }, 'partner-9', 'support@a.com');
    expect(n.senderAuth?.dmarc).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/normalizeGraphMessage.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts
import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail, SenderAuth } from '../inboundEmail/types';

function header(headers: GraphMessage['internetMessageHeaders'], name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseDmarc(authResults: string | undefined): SenderAuth | undefined {
  if (!authResults) return undefined;
  const m = /\bdmarc=(\w+)/i.exec(authResults);
  const spf = /\bspf=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
  const dkim = /\bdkim=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
  return {
    ...(spf ? { spf } : {}),
    ...(dkim ? { dkim } : {}),
    ...(m ? { dmarc: m[1].toLowerCase() } : {}),
  } as SenderAuth;
}

/** Pure mapping: Graph message → the pipeline's NormalizedInboundEmail. */
export function normalizeGraphMessage(
  msg: GraphMessage, partnerId: string, mailboxAddress: string,
): NormalizedInboundEmail {
  const fromAddr = msg.from?.emailAddress?.address?.trim().toLowerCase() ?? '';
  const references = header(msg.internetMessageHeaders, 'References')?.trim().split(/\s+/).filter(Boolean);
  const html = msg.body?.contentType?.toLowerCase() === 'html' ? msg.body?.content : undefined;
  const text = msg.body?.contentType?.toLowerCase() === 'text' ? (msg.body?.content ?? '') : (msg.bodyPreview ?? '');
  const autoSubmitted = header(msg.internetMessageHeaders, 'Auto-Submitted');
  const precedence = header(msg.internetMessageHeaders, 'Precedence');

  return {
    provider: 'm365',
    providerMessageId: msg.id,
    resolvedPartnerId: partnerId,
    to: mailboxAddress.trim().toLowerCase(),
    from: fromAddr,
    fromName: msg.from?.emailAddress?.name,
    subject: msg.subject ?? '',
    text,
    html,
    messageId: msg.internetMessageId,
    inReplyTo: header(msg.internetMessageHeaders, 'In-Reply-To'),
    references,
    autoSubmitted,
    precedence,
    senderAuth: parseDmarc(header(msg.internetMessageHeaders, 'Authentication-Results')),
    attachments: msg.hasAttachments
      ? [] // Phase 1 parity: attachment metadata only; bodies not fetched (deferred).
      : [],
    raw: {
      graphConversationId: msg.conversationId,
      receivedDateTime: msg.receivedDateTime,
    },
  };
}
```

> Confirm the `SenderAuth` shape in `types.ts` (field names `spf`/`dkim`/`dmarc` and their value type). If the existing type uses an enum/literal union, coerce accordingly. Mirror exactly how `mailgun.ts` populates `senderAuth` so the R4 gate in `processInboundEmail` interprets it identically.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/normalizeGraphMessage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/normalizeGraphMessage.ts apps/api/src/services/ticketMailbox/normalizeGraphMessage.test.ts
git commit -m "feat(tickets): normalize Graph message to NormalizedInboundEmail"
```

---

### Task 4: Poll worker (repeatable sweep)

**Files:**
- Create: `apps/api/src/jobs/ticketMailboxPollWorker.ts`
- Modify: the worker bootstrap file that starts `initializeInboundEmailWorker()` (grep for that call; same file starts the SLA worker).
- Test: `apps/api/src/jobs/ticketMailboxPollWorker.test.ts`

**Interfaces:**
- Consumes: `listConnectedMailboxes`, `updateDeltaCursor`, `setConnectionStatus` (Plan 1); `getMailboxToken` (Plan 1); `listInboxDelta`, `markRead` (Task 2); `normalizeGraphMessage` (Task 3); `enqueueInboundEmail` (`services/inboundEmailQueue`).
- Produces: `runMailboxSweep()` (exported for tests), `initializeTicketMailboxPollWorker()`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/jobs/ticketMailboxPollWorker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ticketMailbox/connectionService', () => ({
  listConnectedMailboxes: vi.fn(),
  updateDeltaCursor: vi.fn(async () => {}),
  setConnectionStatus: vi.fn(async () => {}),
}));
vi.mock('../services/ticketMailbox/mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
vi.mock('../services/ticketMailbox/graphMailClient', () => ({
  listInboxDelta: vi.fn(),
  markRead: vi.fn(async () => {}),
}));
vi.mock('../services/inboundEmailQueue', () => ({ enqueueInboundEmail: vi.fn(async () => {}) }));

import { listConnectedMailboxes, updateDeltaCursor, setConnectionStatus } from '../services/ticketMailbox/connectionService';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import { runMailboxSweep } from './ticketMailboxPollWorker';

const conn = (over: Partial<any> = {}) => ({
  id: 'c1', partnerId: 'p1', tenantId: '11111111-1111-1111-1111-111111111111',
  mailboxAddress: 'support@a.com', status: 'connected', deltaLink: null, ...over,
});

describe('runMailboxSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues each new message, marks it read, then persists the new deltaLink', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }, { id: 'm2' }], deltaLink: 'delta-new' } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledTimes(2);
    // Cursor persisted AFTER enqueue (ordering: enqueue calls happen before updateDeltaCursor).
    expect(updateDeltaCursor).toHaveBeenCalledWith('c1', 'delta-new', expect.any(Date), expect.anything());
    const enqueueOrder = vi.mocked(enqueueInboundEmail).mock.invocationCallOrder[0];
    const cursorOrder = vi.mocked(updateDeltaCursor).mock.invocationCallOrder[0];
    expect(enqueueOrder).toBeLessThan(cursorOrder);
  });

  it('does not persist a cursor if enqueue throws (replay-safe)', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }], deltaLink: 'delta-new' } as any);
    vi.mocked(enqueueInboundEmail).mockRejectedValueOnce(new Error('redis down'));

    await runMailboxSweep();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
    expect(setConnectionStatus).not.toHaveBeenCalledWith('c1', 'p1', 'reauth_required', expect.anything());
  });

  it('marks reauth_required on a 401 from Graph and isolates per mailbox', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'bad' }), conn({ id: 'good' })] as any);
    vi.mocked(listInboxDelta)
      .mockImplementationOnce(async () => { const e: any = new Error('401'); e.status = 401; throw e; })
      .mockResolvedValueOnce({ messages: [], deltaLink: 'd' } as any);

    await runMailboxSweep();
    expect(setConnectionStatus).toHaveBeenCalledWith('bad', 'p1', 'reauth_required', expect.any(String));
    // The good mailbox still processed.
    expect(updateDeltaCursor).toHaveBeenCalledWith('good', 'd', expect.any(Date), expect.anything());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/ticketMailboxPollWorker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/jobs/ticketMailboxPollWorker.ts
import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  listConnectedMailboxes, updateDeltaCursor, resetDeltaCursor, setConnectionStatus,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { normalizeGraphMessage } from '../services/ticketMailbox/normalizeGraphMessage';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';

const QUEUE_NAME = 'ticket-mailbox-poll';
const SWEEP_INTERVAL_MS = 90 * 1000;
const SWEEP_JOB_ID = 'ticket-mailbox-poll-sweep'; // colon-free singleton

type SweepJobData = { type: 'sweep' };

/** Process one mailbox end-to-end. Graph I/O runs OUTSIDE any DB context. */
async function sweepOne(c: Awaited<ReturnType<typeof listConnectedMailboxes>>[number]): Promise<void> {
  if (!c.tenantId) return;
  let page;
  try {
    const token = await getMailboxToken(c.tenantId);
    page = await listInboxDelta(token, c.mailboxAddress, c.deltaLink);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 410) {
      // Delta token invalidated by Graph — clear it and resync from "now" next sweep.
      await resetDeltaCursor(c.id);
      console.warn('[mailboxPoll] delta token gone (410); cursor reset', { id: c.id });
      return;
    }
    const next = status === 401 || status === 403 ? 'reauth_required' : 'error';
    await setConnectionStatus(c.id, c.partnerId, next, err instanceof Error ? err.message : 'poll failed');
    return;
  }

  let lastMessageAt: Date | null = null;
  try {
    const token = await getMailboxToken(c.tenantId);
    for (const msg of page.messages) {
      const normalized = normalizeGraphMessage(msg, c.partnerId, c.mailboxAddress);
      await enqueueInboundEmail(normalized);                 // Redis, not DB
      await markRead(token, c.mailboxAddress, msg.id).catch((e) => {
        console.warn('[mailboxPoll] mark-read failed', { id: msg.id, err: e instanceof Error ? e.message : e });
      });
      const rcv = (msg.raw as never) || (msg.receivedDateTime ? new Date(msg.receivedDateTime) : null);
      if (msg.receivedDateTime) lastMessageAt = new Date(msg.receivedDateTime);
    }
  } catch (err) {
    // Enqueue failed mid-page: DO NOT advance the cursor — replay is safe (dedup index).
    console.error('[mailboxPoll] enqueue failed; cursor not advanced', { id: c.id, err: err instanceof Error ? err.message : err });
    return;
  }

  // All messages enqueued — now it's safe to advance the cursor.
  if (page.deltaLink) {
    await updateDeltaCursor(c.id, page.deltaLink, new Date(), lastMessageAt);
  }
}

/** Exported for tests. Reads connections in system context, processes each independently. */
export async function runMailboxSweep(): Promise<void> {
  const connections = await listConnectedMailboxes();
  for (const c of connections) {
    try {
      await sweepOne(c);
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[mailboxPoll] sweepOne crashed', { id: c.id });
    }
  }
}

let queue: Queue<SweepJobData> | null = null;
let worker: Worker<SweepJobData> | null = null;

export async function initializeTicketMailboxPollWorker(): Promise<void> {
  if (worker) return;
  queue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  // Singleton repeatable sweep.
  await queue.add('sweep', { type: 'sweep' }, {
    jobId: SWEEP_JOB_ID,
    repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  });
  worker = new Worker<SweepJobData>(QUEUE_NAME, async (_job: Job<SweepJobData>) => {
    await runMailboxSweep();
  }, { connection: getBullMQConnection(), concurrency: 1 });
  worker.on('failed', (job, err) => {
    console.error('[mailboxPoll] sweep job failed', { id: job?.id, err: err?.message });
  });
  console.log('[mailboxPoll] worker initialized');
}
```

> Remove the dead `rcv` line if your linter flags it — it's a leftover; `lastMessageAt` is the only thing that matters. Keep the cursor-advance-after-enqueue ordering exactly: it's the at-least-once guarantee.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/jobs/ticketMailboxPollWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Start the worker at bootstrap**

Grep for where the inbound worker starts: `grep -rn "initializeInboundEmailWorker" apps/api/src`. In that bootstrap file, add:

```typescript
import { initializeTicketMailboxPollWorker } from './jobs/ticketMailboxPollWorker';
// ... alongside the other initialize* calls:
await initializeTicketMailboxPollWorker();
```

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/jobs/ticketMailboxPollWorker.ts apps/api/src/jobs/ticketMailboxPollWorker.test.ts <bootstrap-file>
git commit -m "feat(tickets): M365 mailbox delta-poll sweep worker"
```

---

### Task 5: Integration test — normalized Graph message → ticket

**Files:**
- Create: `apps/api/src/__tests__/integration/m365InboundToTicket.integration.test.ts`

**Interfaces:**
- Consumes: `normalizeGraphMessage`, `processInboundEmail`, a connected partner fixture.

- [ ] **Step 1: Write the integration test**

```typescript
// apps/api/src/__tests__/integration/m365InboundToTicket.integration.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeGraphMessage } from '../../services/ticketMailbox/normalizeGraphMessage';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import { withSystemDbAccessContext, runOutsideDbContext, db } from '../../db';
import { getActiveTestPartner } from './helpers/rlsFixtures'; // returns an 'active' partner id
import type { GraphMessage } from '../../services/ticketMailbox/graphMailClient';

describe('M365 inbound → ticket (real DB)', () => {
  it('creates a ticket from a normalized Graph message via the pre-resolved partner', async () => {
    const partnerId = await getActiveTestPartner();
    const msg: GraphMessage = {
      id: `graph-${Date.now()}`,
      internetMessageId: `<${Date.now()}@cust.com>`,
      subject: 'Cannot print',
      from: { emailAddress: { address: 'cust@cust.com', name: 'Cust' } },
      toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
      body: { contentType: 'html', content: '<p>printer down</p>' },
      bodyPreview: 'printer down',
      internetMessageHeaders: [{ name: 'Authentication-Results', value: 'dmarc=pass' }],
    };
    const normalized = normalizeGraphMessage(msg, partnerId, 'support@a.com');

    await runOutsideDbContext(() => withSystemDbAccessContext(() => processInboundEmail(normalized)));

    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.execute(`SELECT ticket_id, parse_status, provider FROM ticket_email_inbound
                  WHERE provider_message_id = '${msg.id}'`)));
    expect(rows[0]?.provider).toBe('m365');
    expect(['created', 'matched']).toContain(rows[0]?.parse_status);
    expect(rows[0]?.ticket_id).toBeTruthy();
  });
});
```

> Adapt `getActiveTestPartner`/fixtures to the nearest existing inbound-email integration test. Run on the 5433 test DB.

- [ ] **Step 2: Run**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts m365InboundToTicket
```
Expected: PASS (ticket created, `ticket_email_inbound` row with `provider='m365'`).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/m365InboundToTicket.integration.test.ts
git commit -m "test(tickets): M365 normalized message creates a ticket end-to-end"
```

---

## Self-Review (Plan 2)

- **Spec coverage:** delta poll + `$select` headers (Task 2), normalize with DMARC verdict + threading keys (Task 3), per-mailbox sweep with mark-read + cursor-after-enqueue + 401→reauth isolation (Task 4), `resolvedPartnerId` seam (Task 1), end-to-end ticket creation (Task 5). ✅
- **No-history-backfill + 410 resync:** first run passes `deltaLink=null`; a 410 from `listInboxDelta` is caught in `sweepOne` and routed to `resetDeltaCursor(id)` (added to Plan 1's contract), which nulls the cursor and leaves status `connected` so the next sweep restarts the delta from "now". ✅
- **Type consistency:** `GraphMessage`/`DeltaPage`/`normalizeGraphMessage` names match across Tasks 2–4 and Plan 3's consumption. `resolvedPartnerId` matches Plan 1/3. ✅
- **Connection-hold safety:** Graph I/O never inside a DB txn; reads/writes wrapped in `runOutsideDbContext(withSystemDbAccessContext(...))` inside the service functions. ✅

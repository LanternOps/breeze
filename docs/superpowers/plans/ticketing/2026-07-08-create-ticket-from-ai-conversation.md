# Create Ticket from AI Conversation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Create Ticket" button to the web technician AI chat panel that drafts a plain-English ticket (problem + resolution + status + time) from the conversation, lets the tech review/edit in a modal, and on save creates the ticket (`source:'ai'`) against the session's org/device and logs a time entry.

**Architecture:** Two new endpoints on the existing AI router — a **draft** endpoint (reads the transcript, makes one LLM summarization call, returns a non-persisted draft) and a **save** endpoint (creates the ticket via the existing `createTicket` service, optionally resolves it, and best-effort logs a time entry). A presentational modal mirrors the existing `CreateVulnTicketModal`; the store exposes thin fetch actions. No new DB table, no migration.

**Tech Stack:** Hono + Zod (`@hono/zod-validator`) API, Drizzle ORM, raw `@anthropic-ai/sdk` for the one-shot LLM call, React + Zustand (`workspaceStore`) + shared `Dialog`/`runAction` on the web.

## Global Constraints

- **No new DB table / no migration** — writes land in existing `tickets` and `time_entries` (both already RLS-covered). Do NOT add a table or migration.
- **Tenant scoping via session load:** always load the session with `getSession(id, auth)` or `getSessionMessages(id, auth)` — these bake `auth.orgCondition(aiSessions.orgId)` into the query; a session the caller can't reach returns `null` → respond `404`. Never trust an `orgId`/`deviceId` from the client body; derive them from the loaded session row.
- **`ticketSourceEnum` already includes `'ai'`** (`apps/api/src/db/schema/portal.ts:8`) — create tickets with `source: 'ai'`.
- **Permission:** both endpoints use `requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action)` and `requireScope('organization','partner','system')`.
- **Time-entry logging is partner/system-scope only** (`time_entries` has no org-axis RLS policy). Only call `createTimeEntry` when `auth.scope === 'partner' || auth.scope === 'system'`, and wrap it in try/catch — a time-entry failure must NOT fail ticket creation.
- **Failure model:** ticket creation is the critical atomic step; resolve + time-entry are best-effort follow-ups. The save response returns `{ data: ticket, resolved: boolean, timeLogged: boolean }`.
- **Web mutations use `runAction`** (`apps/web/src/lib/runAction.ts`) per CLAUDE.md — the modal's Save goes through it.
- **Test conventions:** co-locate test files next to source; follow the `breeze-testing` skill (Drizzle mock patterns, Vitest). API unit tests run under `apps/api/vitest.config.ts`; web tests under `apps/web/vitest.config.ts`.
- **Scope guardrails (do NOT build):** web technician AI agent only (not Helper/Excel); button-triggered only (no autonomous agent tool); no category/assignee/SLA auto-fill; create-only (no attach-to-existing).

## File Structure

**Create:**
- `apps/api/src/services/aiTicketDraft.ts` — transcript → structured draft (LLM call).
- `apps/api/src/services/aiTicketDraft.test.ts` — summarizer unit test (mocked Anthropic).
- `apps/web/src/components/ai/CreateTicketFromChatModal.tsx` — presentational modal.
- `apps/web/src/components/ai/CreateTicketFromChatModal.test.tsx` — modal test.

**Modify:**
- `packages/shared/src/validators/tickets.ts` — add `createTicketFromChatSchema` + `CreateTicketFromChatInput`.
- `packages/shared/src/validators/tickets.test.ts` (or the co-located ticket validator test) — schema tests.
- `packages/shared/src/types/ai.ts` — add `AiTicketDraft` interface.
- `apps/api/src/routes/ai.ts` — add `POST /sessions/:id/ticket-draft` and `POST /sessions/:id/ticket`.
- `apps/api/src/routes/ai.test.ts` (or a sibling `ai.ticket.test.ts`) — route tests.
- `apps/web/src/stores/workspaceStore.ts` — add `draftTicketFromChat` + `saveTicketFromChat` actions to `WorkspaceState`.
- `apps/web/src/components/workspace/WorkspaceChatPanel.tsx` — add the toolbar button + modal wiring.

---

### Task 1: Shared validator + draft type

**Files:**
- Modify: `packages/shared/src/validators/tickets.ts`
- Modify: `packages/shared/src/types/ai.ts`
- Test: `packages/shared/src/validators/tickets.test.ts`

**Interfaces:**
- Produces: `createTicketFromChatSchema` (Zod) + `type CreateTicketFromChatInput`; `interface AiTicketDraft`. Consumed by Tasks 3, 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/validators/tickets.test.ts` (create the file if it does not exist, importing `describe/it/expect` from `vitest`):

```ts
import { describe, it, expect } from 'vitest';
import { createTicketFromChatSchema } from './tickets';

describe('createTicketFromChatSchema', () => {
  const base = { subject: 'Outlook would not open', description: 'Sarah could not open Outlook.', status: 'open' as const, timeMinutes: 15, billable: true };

  it('accepts a valid open-ticket payload', () => {
    expect(createTicketFromChatSchema.parse(base)).toMatchObject({ status: 'open', timeMinutes: 15 });
  });

  it('requires a resolutionNote when status is resolved', () => {
    const r = createTicketFromChatSchema.safeParse({ ...base, status: 'resolved' });
    expect(r.success).toBe(false);
  });

  it('accepts a resolved payload with a resolutionNote', () => {
    const r = createTicketFromChatSchema.safeParse({ ...base, status: 'resolved', resolutionNote: 'Rebuilt the mail profile.' });
    expect(r.success).toBe(true);
  });

  it('rejects negative timeMinutes and empty subject', () => {
    expect(createTicketFromChatSchema.safeParse({ ...base, timeMinutes: -1 }).success).toBe(false);
    expect(createTicketFromChatSchema.safeParse({ ...base, subject: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- tickets.test`
Expected: FAIL — `createTicketFromChatSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/validators/tickets.ts`, near the other ticket schemas (reuse the existing `ticketPrioritySchema` already defined in this file), add:

```ts
export const createTicketFromChatSchema = z
  .object({
    subject: z.string().min(1).max(255),
    description: z.string().max(50_000).optional(),
    status: z.enum(['open', 'resolved']),
    resolutionNote: z.string().max(50_000).optional(),
    timeMinutes: z.number().int().min(0).max(24 * 60),
    billable: z.boolean(),
    priority: ticketPrioritySchema.optional(),
  })
  .refine((v) => v.status !== 'resolved' || (v.resolutionNote?.trim().length ?? 0) > 0, {
    message: 'A resolution note is required to resolve a ticket',
    path: ['resolutionNote'],
  });

export type CreateTicketFromChatInput = z.infer<typeof createTicketFromChatSchema>;
```

If `ticketPrioritySchema` is not already exported/available in this file, use `z.enum(['low', 'normal', 'high', 'urgent']).optional()` inline instead.

- [ ] **Step 4: Add the draft type**

In `packages/shared/src/types/ai.ts` (where `AiPageContext` lives), add:

```ts
export interface AiTicketDraft {
  subject: string;
  problemSummary: string;
  resolutionSummary: string;
  wasFixed: boolean;
  suggestedStatus: 'open' | 'resolved';
  suggestedTimeMinutes: number;
  elapsedMinutes: number;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test -- tickets.test`
Expected: PASS (4 tests).
Also run `pnpm --filter @breeze/shared build` (or `tsc --noEmit`) to confirm the new type compiles and is exported.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts packages/shared/src/types/ai.ts
git commit -m "feat(shared): add createTicketFromChatSchema + AiTicketDraft type"
```

---

### Task 2: Summarization service (`aiTicketDraft.ts`)

**Files:**
- Create: `apps/api/src/services/aiTicketDraft.ts`
- Test: `apps/api/src/services/aiTicketDraft.test.ts`

**Interfaces:**
- Consumes: `aiMessages` rows (`{ role, content, contentBlocks, toolName, createdAt }`), `AiPageContext`/`contextSnapshot` (jsonb), `elapsedMinutes: number`.
- Produces:
  ```ts
  export interface DraftInput {
    messages: Array<{ role: string; content: string | null }>;
    contextSnapshot: unknown;
    elapsedMinutes: number;
    model: string;
  }
  export interface DraftResult {
    subject: string; problemSummary: string; resolutionSummary: string;
    wasFixed: boolean; suggestedTimeMinutes: number;
    inputTokens: number; outputTokens: number;
  }
  export class ThinTranscriptError extends Error {}
  export async function draftTicketFromTranscript(input: DraftInput): Promise<DraftResult>
  ```
  Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/aiTicketDraft.test.ts`. Mock the Anthropic SDK so no network call happens:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock }; },
}));

import { draftTicketFromTranscript, ThinTranscriptError } from './aiTicketDraft';

function reply(json: object, inTok = 100, outTok = 50) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const transcript = [
  { role: 'user', content: 'Outlook will not open on my PC' },
  { role: 'assistant', content: 'I rebuilt your mail profile; it is working now.' },
];

beforeEach(() => createMock.mockReset());

describe('draftTicketFromTranscript', () => {
  it('returns a structured draft and maps wasFixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 'Outlook would not open', problemSummary: 'Outlook would not start.', resolutionSummary: 'Rebuilt the mail profile.', wasFixed: true, suggestedTimeMinutes: 15 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });
    expect(r.wasFixed).toBe(true);
    expect(r.subject).toBe('Outlook would not open');
    expect(r.outputTokens).toBe(50);
  });

  it('clamps suggestedTimeMinutes to the elapsed ceiling', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 999 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });
    expect(r.suggestedTimeMinutes).toBeLessThanOrEqual(25);
  });

  it('retries once on invalid JSON then throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws ThinTranscriptError when there is no assistant turn', async () => {
    await expect(draftTicketFromTranscript({ messages: [{ role: 'user', content: 'hi' }], contextSnapshot: null, elapsedMinutes: 5, model: 'claude-x' })).rejects.toBeInstanceOf(ThinTranscriptError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- aiTicketDraft`
Expected: FAIL — module `./aiTicketDraft` not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/aiTicketDraft.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface DraftInput {
  messages: Array<{ role: string; content: string | null }>;
  contextSnapshot: unknown;
  elapsedMinutes: number;
  model: string;
}
export interface DraftResult {
  subject: string;
  problemSummary: string;
  resolutionSummary: string;
  wasFixed: boolean;
  suggestedTimeMinutes: number;
  inputTokens: number;
  outputTokens: number;
}
export class ThinTranscriptError extends Error {
  constructor() { super('Not enough conversation to draft a ticket'); this.name = 'ThinTranscriptError'; }
}

const llmSchema = z.object({
  subject: z.string().min(1).max(120),
  problemSummary: z.string().min(1),
  resolutionSummary: z.string(),
  wasFixed: z.boolean(),
  suggestedTimeMinutes: z.number().int().min(0),
});

const SYSTEM_PROMPT = [
  'You turn an IT support chat transcript into a support ticket for a non-technical reader (a customer or office manager).',
  'Write plain English. No jargon, no command output, no internal tool names.',
  'Return ONLY a JSON object with keys: subject (<=120 chars), problemSummary, resolutionSummary, wasFixed (boolean), suggestedTimeMinutes (integer).',
  'The resolution text is shown to the customer. Leave resolutionSummary as an empty string if the issue was not resolved.',
  'Set wasFixed true ONLY if the transcript shows the issue was actually verified fixed — not merely attempted.',
  'suggestedTimeMinutes is hands-on work time; seed it from the elapsed ceiling provided but reduce it for idle gaps or non-work chatter. Never exceed the elapsed ceiling.',
].join(' ');

function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: string; text?: string };
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

function buildUserContent(input: DraftInput): string {
  const lines = input.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim().length > 0)
    .map((m) => `${m.role === 'user' ? 'Technician/User' : 'Assistant'}: ${m.content!.trim()}`);
  const ctx = input.contextSnapshot ? `Context: ${JSON.stringify(input.contextSnapshot)}\n` : '';
  return `${ctx}Elapsed ceiling (minutes): ${input.elapsedMinutes}\n\nTranscript:\n${lines.join('\n')}`;
}

export async function draftTicketFromTranscript(input: DraftInput): Promise<DraftResult> {
  const hasAssistant = input.messages.some((m) => m.role === 'assistant' && m.content && m.content.trim().length > 0);
  if (!hasAssistant) throw new ThinTranscriptError();

  const client = new Anthropic();
  const userContent = buildUserContent(input);
  let lastErr: unknown;
  let inTok = 0;
  let outTok = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.messages.create({
      model: input.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
    inTok = resp.usage?.input_tokens ?? 0;
    outTok = resp.usage?.output_tokens ?? 0;
    const text = lastTextBlock(resp.content);
    if (text) {
      try {
        const parsed = llmSchema.parse(JSON.parse(text));
        return {
          subject: parsed.subject,
          problemSummary: parsed.problemSummary,
          resolutionSummary: parsed.wasFixed ? parsed.resolutionSummary : '',
          wasFixed: parsed.wasFixed,
          suggestedTimeMinutes: Math.min(parsed.suggestedTimeMinutes, Math.max(0, Math.round(input.elapsedMinutes))),
          inputTokens: inTok,
          outputTokens: outTok,
        };
      } catch (err) { lastErr = err; }
    }
  }
  throw new Error(`Failed to draft ticket from transcript: ${String(lastErr)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- aiTicketDraft`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiTicketDraft.ts apps/api/src/services/aiTicketDraft.test.ts
git commit -m "feat(api): add aiTicketDraft summarization service"
```

---

### Task 3: Draft endpoint — `POST /ai/sessions/:id/ticket-draft`

**Files:**
- Modify: `apps/api/src/routes/ai.ts`
- Test: `apps/api/src/routes/ai.ticket.test.ts` (new sibling test file)

**Interfaces:**
- Consumes: `draftTicketFromTranscript` + `ThinTranscriptError` (Task 2), `AiTicketDraft` (Task 1), `getSessionMessages(id, auth)` (`aiAgent.ts:244`), `resolveDefaultModel` (`aiAgent.ts:38`), `recordUsage(sessionId, orgId, model, inTok, outTok, isToolExecution)` (`aiCostTracker.ts:293`).
- Produces: `POST /ai/sessions/:id/ticket-draft` → `200 { data: AiTicketDraft }` | `404` | `422`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/ai.ticket.test.ts`. Mock the summarizer, the session loader, org/device lookups, and cost tracker so the route runs without a DB. Mirror how existing route tests in this repo build a Hono test app + inject an `auth` context (check `apps/api/src/routes/ai.test.ts` or a nearby route test for the exact `app.request`/auth-injection harness and copy it). The behavioral assertions:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMessagesMock = vi.fn();
const draftMock = vi.fn();
const recordUsageMock = vi.fn();

vi.mock('../services/aiAgent', async (orig) => ({ ...(await orig()), getSessionMessages: getSessionMessagesMock, resolveDefaultModel: () => 'claude-test' }));
vi.mock('../services/aiTicketDraft', () => ({
  draftTicketFromTranscript: draftMock,
  ThinTranscriptError: class ThinTranscriptError extends Error {},
}));
vi.mock('../services/aiCostTracker', async (orig) => ({ ...(await orig()), recordUsage: recordUsageMock }));

// ...import the test app harness + a helper to POST as a given auth context...

beforeEach(() => { getSessionMessagesMock.mockReset(); draftMock.mockReset(); recordUsageMock.mockReset(); });

describe('POST /ai/sessions/:id/ticket-draft', () => {
  it('returns a draft assembled from the session + summarizer', async () => {
    getSessionMessagesMock.mockResolvedValue({ session: { id: 's1', orgId: 'org1', deviceId: null, createdAt: new Date(Date.now() - 25 * 60000), contextSnapshot: null }, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }] });
    draftMock.mockResolvedValue({ subject: 'S', problemSummary: 'P', resolutionSummary: 'R', wasFixed: true, suggestedTimeMinutes: 15, inputTokens: 10, outputTokens: 5 });
    const res = await postDraft('s1', partnerAuth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ subject: 'S', suggestedStatus: 'resolved', orgId: 'org1' });
  });

  it('404 when the session is not reachable', async () => {
    getSessionMessagesMock.mockResolvedValue(null);
    expect((await postDraft('sX', partnerAuth)).status).toBe(404);
  });

  it('422 on a thin transcript', async () => {
    getSessionMessagesMock.mockResolvedValue({ session: { id: 's1', orgId: 'org1', deviceId: null, createdAt: new Date(), contextSnapshot: null }, messages: [{ role: 'user', content: 'hi' }] });
    draftMock.mockRejectedValue(new (await import('../services/aiTicketDraft')).ThinTranscriptError());
    expect((await postDraft('s1', partnerAuth)).status).toBe(422);
  });
});
```

(`postDraft`, `partnerAuth`, and the app harness come from the copied test scaffold.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- ai.ticket`
Expected: FAIL — route returns 404 for everything / handler not found.

- [ ] **Step 3: Add imports to `ai.ts`**

At the top of `apps/api/src/routes/ai.ts`, extend the existing imports:

```ts
// NOTE: getSession + getSessionMessages are ALREADY imported from '../services/aiAgent'
//       (the existing named import); only ADD resolveDefaultModel to that same line:
import { /* ...existing..., */ resolveDefaultModel } from '../services/aiAgent';
// recordUsage is NOT yet imported — ADD it to the existing '../services/aiCostTracker' import:
import { /* ...existing..., */ recordUsage } from '../services/aiCostTracker';
// organizations + devices — ADD to the existing '../db/schema' import (which already has aiSessions/aiMessages):
import { /* aiSessions, aiMessages, ... */ organizations, devices } from '../db/schema';
// Genuinely new imports:
import { draftTicketFromTranscript, ThinTranscriptError } from '../services/aiTicketDraft';
import { createTicket, changeTicketStatus, TicketServiceError } from '../services/ticketService';
import { createTimeEntry } from '../services/timeEntryService';
import { deviceInSiteScope } from './tickets/siteScope';
import { timeActorFrom } from './timeEntries/timeEntries';
import { createTicketFromChatSchema, type AiTicketDraft } from '@breeze/shared';
```
> `db`, `eq`, `zValidator`, `z`, `requireScope`, `requirePermission`, `PERMISSIONS`, and `writeRouteAudit` are already imported in `ai.ts` — do not re-import them.

Also add a permission constant near the existing `requireAiWrite`:

```ts
const requireTicketsWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
```

- [ ] **Step 4: Implement the draft handler**

Add to `apps/api/src/routes/ai.ts` (near the other `/sessions/:id/...` routes):

```ts
aiRoutes.post(
  '/sessions/:id/ticket-draft',
  requireScope('organization', 'partner', 'system'),
  requireTicketsWrite,
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;

    const loaded = await getSessionMessages(sessionId, auth);
    if (!loaded) return c.json({ error: 'Session not found' }, 404);
    const { session, messages } = loaded;

    const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(session.createdAt).getTime()) / 60000));
    const model = session.model ?? resolveDefaultModel();

    let draft;
    try {
      draft = await draftTicketFromTranscript({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        contextSnapshot: session.contextSnapshot,
        elapsedMinutes,
        model,
      });
    } catch (err) {
      if (err instanceof ThinTranscriptError) return c.json({ error: err.message }, 422);
      return c.json({ error: 'Could not draft a ticket from this conversation' }, 422);
    }

    // Best-effort cost accounting; never fails the request.
    try { await recordUsage(sessionId, session.orgId, model, draft.inputTokens, draft.outputTokens, false); } catch { /* non-fatal */ }

    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, session.orgId)).limit(1);
    let deviceHostname: string | null = null;
    if (session.deviceId) {
      const [dev] = await db.select({ hostname: devices.hostname }).from(devices).where(eq(devices.id, session.deviceId)).limit(1);
      deviceHostname = dev?.hostname ?? null;
    }

    const payload: AiTicketDraft = {
      subject: draft.subject,
      problemSummary: draft.problemSummary,
      resolutionSummary: draft.resolutionSummary,
      wasFixed: draft.wasFixed,
      suggestedStatus: draft.wasFixed ? 'resolved' : 'open',
      suggestedTimeMinutes: draft.suggestedTimeMinutes,
      elapsedMinutes,
      orgId: session.orgId,
      orgName: org?.name ?? null,
      deviceId: session.deviceId ?? null,
      deviceHostname,
    };
    return c.json({ data: payload });
  }
);
```

> Note: confirm `devices.hostname` is the correct column name (it is used across the ticketing/device code); if the column differs, adjust the select.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- ai.ticket`
Expected: the three draft tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai.ticket.test.ts
git commit -m "feat(api): add AI conversation ticket-draft endpoint"
```

---

### Task 4: Save endpoint — `POST /ai/sessions/:id/ticket`

**Files:**
- Modify: `apps/api/src/routes/ai.ts`
- Test: `apps/api/src/routes/ai.ticket.test.ts` (extend)

**Interfaces:**
- Consumes: `getSession(id, auth)` (`aiAgent.ts:162`), `createTicket` / `changeTicketStatus` / `TicketServiceError` (`ticketService.ts`), `createTimeEntry` (`timeEntryService.ts:188`), `timeActorFrom(c)` (`timeEntries.ts:29`), `deviceInSiteScope(auth, deviceId)` (`tickets/siteScope.ts:17`), `createTicketFromChatSchema` (Task 1).
- Produces: `POST /ai/sessions/:id/ticket` → `201 { data: ticket, resolved: boolean, timeLogged: boolean }` | `404` | `400`.

- [ ] **Step 1: Write the failing test**

Extend `apps/api/src/routes/ai.ticket.test.ts`. Mock `getSession`, `createTicket`, `changeTicketStatus`, `createTimeEntry`, `deviceInSiteScope`:

```ts
const getSessionMock = vi.fn();
const createTicketMock = vi.fn();
const changeStatusMock = vi.fn();
const createTimeEntryMock = vi.fn();
const deviceInSiteScopeMock = vi.fn();

// extend the existing vi.mock('../services/aiAgent', ...) to also export getSession: getSessionMock
vi.mock('../services/ticketService', async (orig) => ({ ...(await orig()), createTicket: createTicketMock, changeTicketStatus: changeStatusMock }));
vi.mock('../services/timeEntryService', async (orig) => ({ ...(await orig()), createTimeEntry: createTimeEntryMock }));
vi.mock('./tickets/siteScope', () => ({ deviceInSiteScope: deviceInSiteScopeMock }));

describe('POST /ai/sessions/:id/ticket', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue({ id: 's1', orgId: 'org1', deviceId: 'dev1', model: null });
    createTicketMock.mockResolvedValue({ id: 't1', ticketNumber: 'ORG-1', orgId: 'org1', status: 'new' });
    deviceInSiteScopeMock.mockResolvedValue(true);
    changeStatusMock.mockResolvedValue({ id: 't1', status: 'resolved' });
    createTimeEntryMock.mockResolvedValue({ id: 'te1' });
  });

  const body = { subject: 'S', description: 'P', status: 'open', timeMinutes: 15, billable: true };

  it('creates a ticket with source ai and logs time for a partner-scope caller', async () => {
    const res = await postTicket('s1', partnerAuth, body);
    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai', orgId: 'org1', deviceId: 'dev1' }), expect.any(Object));
    expect(createTimeEntryMock).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(json).toMatchObject({ resolved: false, timeLogged: true });
  });

  it('resolves the ticket and sets the resolution note', async () => {
    const res = await postTicket('s1', partnerAuth, { ...body, status: 'resolved', resolutionNote: 'Fixed it.' });
    expect(res.status).toBe(201);
    expect(changeStatusMock).toHaveBeenCalledWith('t1', { status: 'resolved' }, { resolutionNote: 'Fixed it.' }, expect.any(Object));
    expect((await res.json()).resolved).toBe(true);
  });

  it('does not log time for an org-scope caller', async () => {
    const res = await postTicket('s1', orgAuth, body); // orgAuth.scope === 'organization'
    expect(res.status).toBe(201);
    expect(createTimeEntryMock).not.toHaveBeenCalled();
    expect((await res.json()).timeLogged).toBe(false);
  });

  it('drops deviceId when the caller fails site scope', async () => {
    deviceInSiteScopeMock.mockResolvedValue(false);
    await postTicket('s1', partnerAuth, body);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({ deviceId: undefined }), expect.any(Object));
  });

  it('404 when the session is unreachable', async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await postTicket('sX', partnerAuth, body)).status).toBe(404);
  });

  it('400 when resolving without a note (schema)', async () => {
    expect((await postTicket('s1', partnerAuth, { ...body, status: 'resolved' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- ai.ticket`
Expected: FAIL — save route not implemented.

- [ ] **Step 3: Implement the save handler**

Add to `apps/api/src/routes/ai.ts`:

```ts
aiRoutes.post(
  '/sessions/:id/ticket',
  requireScope('organization', 'partner', 'system'),
  requireTicketsWrite,
  zValidator('json', createTicketFromChatSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');

    const session = await getSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    // deviceId comes from the session; drop it if a site-restricted caller can't reach the device.
    let deviceId: string | undefined = session.deviceId ?? undefined;
    if (deviceId && !(await deviceInSiteScope(auth, deviceId))) deviceId = undefined;

    const actor = { userId: auth.user.id, name: auth.user.name, email: auth.user.email };

    let ticket;
    try {
      ticket = await createTicket(
        { source: 'ai', orgId: session.orgId, subject: body.subject, description: body.description, deviceId, priority: body.priority },
        actor,
      );
    } catch (err) {
      if (err instanceof TicketServiceError) return c.json({ error: err.message }, err.status ?? 400);
      throw err;
    }

    let resolved = false;
    if (body.status === 'resolved') {
      try {
        await changeTicketStatus(ticket.id, { status: 'resolved' }, { resolutionNote: body.resolutionNote }, actor);
        resolved = true;
      } catch { /* ticket persists; resolved:false reported */ }
    }

    let timeLogged = false;
    if (body.timeMinutes > 0 && (auth.scope === 'partner' || auth.scope === 'system')) {
      try {
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - body.timeMinutes * 60_000);
        await createTimeEntry(
          { ticketId: ticket.id, startedAt, endedAt, description: 'Logged from AI conversation', isBillable: body.billable },
          timeActorFrom(c),
        );
        timeLogged = true;
      } catch { /* non-fatal */ }
    }

    writeRouteAudit(c, { orgId: session.orgId, action: 'ai.session.create_ticket', resourceType: 'ticket', resourceId: ticket.id });
    return c.json({ data: ticket, resolved, timeLogged }, 201);
  }
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- ai.ticket`
Expected: all Task 3 + Task 4 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit` (or the repo's `pnpm --filter @breeze/api build`).
Expected: no type errors from the new route.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai.ticket.test.ts
git commit -m "feat(api): add AI conversation create-ticket save endpoint"
```

---

### Task 5: Web store actions

**Files:**
- Modify: `apps/web/src/stores/workspaceStore.ts`

**Interfaces:**
- Consumes: `AiTicketDraft` + `CreateTicketFromChatInput` (`@breeze/shared`), `fetchWithAuth` (already imported in the store), `runAction`/`ActionError` (`@/lib/runAction`).
- Produces (add to the `WorkspaceState` interface and the store object):
  ```ts
  draftTicketFromChat: (tabId: string) => Promise<AiTicketDraft>;
  saveTicketFromChat: (tabId: string, payload: CreateTicketFromChatInput) => Promise<{ ticketNumber: string; resolved: boolean; timeLogged: boolean }>;
  ```
  Consumed by Task 7.

- [ ] **Step 1: Add imports and interface members**

In `apps/web/src/stores/workspaceStore.ts`:
- Add to the top imports: `import { runAction } from '@/lib/runAction';` and extend the shared-types import with `AiTicketDraft, CreateTicketFromChatInput`.
- Add the two signatures above to the `WorkspaceState` interface (next to `flagSession`).

- [ ] **Step 2: Implement `draftTicketFromChat`**

In the store object (mirror `flagSession`'s tab lookup pattern; `draft` throws so the caller can open the modal in manual-entry mode on failure):

```ts
draftTicketFromChat: async (tabId) => {
  const tab = getTab(tabId);
  if (!tab?.sessionId) throw new Error('No active session');
  const res = await fetchWithAuth(`/ai/sessions/${tab.sessionId}/ticket-draft`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(extractApiError(data, 'Could not draft a ticket from this conversation'));
  }
  const body = await res.json();
  return body.data as AiTicketDraft;
},
```

- [ ] **Step 3: Implement `saveTicketFromChat`**

```ts
saveTicketFromChat: async (tabId, payload) => {
  const tab = getTab(tabId);
  if (!tab?.sessionId) throw new Error('No active session');
  const sessionId = tab.sessionId;
  return runAction<{ ticketNumber: string; resolved: boolean; timeLogged: boolean }>({
    request: () => fetchWithAuth(`/ai/sessions/${sessionId}/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    errorFallback: 'Could not create the ticket.',
    parseSuccess: (data) => {
      const d = data as { data?: { ticketNumber?: string }; resolved?: boolean; timeLogged?: boolean };
      return { ticketNumber: d.data?.ticketNumber ?? '', resolved: !!d.resolved, timeLogged: !!d.timeLogged };
    },
    successMessage: (r) => `Ticket ${r.ticketNumber} created${r.resolved ? ' and resolved' : ''}${r.timeLogged ? '' : ' (time not logged)'}`,
  });
},
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @breeze/web exec tsc --noEmit` (or `pnpm --filter @breeze/web astro check` if that's the repo's web typecheck).
Expected: no errors. (No dedicated store unit test in this repo pattern; the actions are exercised via Task 7's component test.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/workspaceStore.ts
git commit -m "feat(web): add draft/save ticket-from-chat store actions"
```

---

### Task 6: Modal component

**Files:**
- Create: `apps/web/src/components/ai/CreateTicketFromChatModal.tsx`
- Test: `apps/web/src/components/ai/CreateTicketFromChatModal.test.tsx`

**Interfaces:**
- Consumes: shared `Dialog` (`../shared/Dialog`), `AiTicketDraft` (`@breeze/shared`).
- Produces:
  ```ts
  export interface CreateTicketFromChatModalProps {
    draft: AiTicketDraft | null;   // null => manual-entry mode (LLM failed)
    orgName: string | null;
    deviceHostname: string | null;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (payload: {
      subject: string; description: string; status: 'open' | 'resolved';
      resolutionNote?: string; timeMinutes: number; billable: boolean;
    }) => void;
  }
  export default function CreateTicketFromChatModal(props): JSX.Element
  ```
  Consumed by Task 7. Presentational — the API call happens in the parent.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ai/CreateTicketFromChatModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CreateTicketFromChatModal from './CreateTicketFromChatModal';

const draft = {
  subject: 'Outlook would not open', problemSummary: 'Sarah could not open Outlook.',
  resolutionSummary: 'Rebuilt the mail profile.', wasFixed: true,
  suggestedStatus: 'resolved' as const, suggestedTimeMinutes: 15, elapsedMinutes: 25,
  orgId: 'o1', orgName: 'Acme', deviceId: 'd1', deviceHostname: 'WKS-04',
};

function setup(over = {}) {
  const onSubmit = vi.fn();
  render(<CreateTicketFromChatModal draft={draft} orgName="Acme" deviceHostname="WKS-04" busy={false} onCancel={() => {}} onSubmit={onSubmit} {...over} />);
  return { onSubmit };
}

describe('CreateTicketFromChatModal', () => {
  it('prefills fields from the draft', () => {
    setup();
    expect((screen.getByLabelText(/subject/i) as HTMLInputElement).value).toBe('Outlook would not open');
    expect((screen.getByLabelText(/time/i) as HTMLInputElement).value).toBe('15');
  });

  it('requires a resolution note when Resolved is selected', () => {
    const { onSubmit } = setup({ draft: { ...draft, suggestedStatus: 'resolved', resolutionSummary: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create ticket|save/i }));
    expect(onSubmit).not.toHaveBeenCalled(); // blocked: resolution empty
  });

  it('submits the edited payload', () => {
    const { onSubmit } = setup({ draft: { ...draft, suggestedStatus: 'open' } });
    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: 'New subject' } });
    fireEvent.click(screen.getByRole('button', { name: /create ticket|save/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ subject: 'New subject', status: 'open' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- CreateTicketFromChatModal`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the modal**

Create `apps/web/src/components/ai/CreateTicketFromChatModal.tsx`, mirroring `CreateVulnTicketModal.tsx` structure and the shared `Dialog`:

```tsx
import { useId, useState } from 'react';
import { Dialog } from '../shared/Dialog';
import type { AiTicketDraft } from '@breeze/shared';

export interface CreateTicketFromChatModalProps {
  draft: AiTicketDraft | null;
  orgName: string | null;
  deviceHostname: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { subject: string; description: string; status: 'open' | 'resolved'; resolutionNote?: string; timeMinutes: number; billable: boolean }) => void;
}

export default function CreateTicketFromChatModal({ draft, orgName, deviceHostname, busy, onCancel, onSubmit }: CreateTicketFromChatModalProps) {
  const [subject, setSubject] = useState(draft?.subject ?? '');
  const [description, setDescription] = useState(draft?.problemSummary ?? '');
  const [resolutionNote, setResolutionNote] = useState(draft?.resolutionSummary ?? '');
  const [status, setStatus] = useState<'open' | 'resolved'>(draft?.suggestedStatus ?? 'open');
  const [timeMinutes, setTimeMinutes] = useState(String(draft?.suggestedTimeMinutes ?? 0));
  const [billable, setBillable] = useState(true);
  const titleId = useId();

  const resolutionMissing = status === 'resolved' && resolutionNote.trim().length === 0;
  const canSave = subject.trim().length > 0 && !resolutionMissing && !busy;

  const submit = () => {
    if (!canSave) return;
    onSubmit({
      subject: subject.trim(),
      description: description.trim(),
      status,
      resolutionNote: status === 'resolved' ? resolutionNote.trim() : undefined,
      timeMinutes: Math.max(0, parseInt(timeMinutes, 10) || 0),
      billable,
    });
  };

  return (
    <Dialog open onClose={() => { if (!busy) onCancel(); }} title="Create ticket from conversation" labelledBy={titleId} maxWidth="md" className="p-5">
      <h2 id={titleId} className="text-base font-semibold">Create ticket from conversation</h2>
      <p className="mt-1 text-xs text-gray-500">{orgName ?? 'Organization'}{deviceHostname ? ` · ${deviceHostname}` : ''}</p>

      <label className="mt-4 block text-xs font-medium">Subject
        <input aria-label="Subject" className="mt-1 w-full rounded border px-2 py-1 text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />
      </label>

      <label className="mt-3 block text-xs font-medium">Problem
        <textarea aria-label="Problem" className="mt-1 w-full rounded border px-2 py-1 text-sm" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium">Status</legend>
        <label className="mr-4 text-sm"><input type="radio" name="status" checked={status === 'open'} onChange={() => setStatus('open')} /> Open</label>
        <label className="text-sm"><input type="radio" name="status" checked={status === 'resolved'} onChange={() => setStatus('resolved')} /> Resolved</label>
      </fieldset>

      {status === 'resolved' && (
        <label className="mt-3 block text-xs font-medium">Resolution
          <textarea aria-label="Resolution" className="mt-1 w-full rounded border px-2 py-1 text-sm" rows={3} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
          {resolutionMissing && <span className="mt-1 block text-xs text-red-500">A resolution note is required to resolve.</span>}
        </label>
      )}

      <div className="mt-3 flex items-center gap-4">
        <label className="text-xs font-medium">Time (min)
          <input aria-label="Time (minutes)" type="number" min={0} className="ml-2 w-20 rounded border px-2 py-1 text-sm" value={timeMinutes} onChange={(e) => setTimeMinutes(e.target.value)} />
        </label>
        <label className="text-sm"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50" onClick={submit} disabled={!canSave}>Create ticket</button>
      </div>
    </Dialog>
  );
}
```

> Match the repo's existing Tailwind class conventions / button components if `CreateVulnTicketModal` uses shared `Button`/input primitives — prefer those over raw `<button>`/`<input>` for visual consistency. The `aria-label`s must stay so the tests can query fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- CreateTicketFromChatModal`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ai/CreateTicketFromChatModal.tsx apps/web/src/components/ai/CreateTicketFromChatModal.test.tsx
git commit -m "feat(web): add CreateTicketFromChatModal component"
```

---

### Task 7: Wire the button into WorkspaceChatPanel

**Files:**
- Modify: `apps/web/src/components/workspace/WorkspaceChatPanel.tsx`
- Test: `apps/web/src/components/workspace/WorkspaceChatPanel.test.tsx` (new)

**Interfaces:**
- Consumes: `draftTicketFromChat` / `saveTicketFromChat` (Task 5), `CreateTicketFromChatModal` (Task 6), `ActionError` (`@/lib/runAction`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/workspace/WorkspaceChatPanel.test.tsx`. Mock `useWorkspaceStore` to return the actions + a tab, and the child components so the test focuses on the button gating:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../ai/AiChatMessages', () => ({ default: () => <div /> }));
vi.mock('../ai/AiChatInput', () => ({ default: () => <div /> }));
vi.mock('../ai/AiContextBadge', () => ({ default: () => <div /> }));
vi.mock('../ai/AiCostIndicator', () => ({ default: () => <div /> }));

const store = { sendMessage: vi.fn(), approveExecution: vi.fn(), approvePlan: vi.fn(), abortPlan: vi.fn(), pauseAi: vi.fn(), interruptResponse: vi.fn(), clearError: vi.fn(), draftTicketFromChat: vi.fn(), saveTicketFromChat: vi.fn() };
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: () => store }));

import WorkspaceChatPanel from './WorkspaceChatPanel';

const baseTab = (over = {}) => ({ id: 't', sessionId: 's1', messages: [], pageContext: null, error: null, isLoading: false, isStreaming: false, isInterrupting: false, pendingApproval: null, pendingPlan: null, activePlan: null, approvalMode: 'auto', isPaused: false, ...over });

describe('WorkspaceChatPanel — Create Ticket button', () => {
  it('disables the button until there is an assistant message', () => {
    render(<WorkspaceChatPanel tab={baseTab({ messages: [{ role: 'user', content: 'hi' }] }) as any} />);
    expect(screen.getByRole('button', { name: /create ticket/i })).toBeDisabled();
  });

  it('enables the button once an assistant message exists', () => {
    render(<WorkspaceChatPanel tab={baseTab({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'done' }] }) as any} />);
    expect(screen.getByRole('button', { name: /create ticket/i })).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- WorkspaceChatPanel`
Expected: FAIL — no "Create Ticket" button.

- [ ] **Step 3: Add the button + modal wiring**

Modify `apps/web/src/components/workspace/WorkspaceChatPanel.tsx`:

```tsx
import { useState } from 'react';
import AiChatMessages from '../ai/AiChatMessages';
import AiChatInput from '../ai/AiChatInput';
import AiContextBadge from '../ai/AiContextBadge';
import AiCostIndicator from '../ai/AiCostIndicator';
import CreateTicketFromChatModal from '../ai/CreateTicketFromChatModal';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { ActionError } from '@/lib/runAction';
import type { AiTicketDraft } from '@breeze/shared';
import type { TabState } from '@/stores/workspaceStore';

interface WorkspaceChatPanelProps { tab: TabState; }

export default function WorkspaceChatPanel({ tab }: WorkspaceChatPanelProps) {
  const {
    sendMessage, approveExecution, approvePlan, abortPlan, pauseAi, interruptResponse, clearError,
    draftTicketFromChat, saveTicketFromChat,
  } = useWorkspaceStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<AiTicketDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const hasAssistantMsg = tab.messages.some((m) => m.role === 'assistant');
  const canCreateTicket = !!tab.sessionId && hasAssistantMsg;

  const openTicketModal = async () => {
    setBusy(true);
    setModalOpen(true);
    try {
      setDraft(await draftTicketFromChat(tab.id));
    } catch {
      setDraft(null); // manual-entry mode; modal still opens
    } finally {
      setBusy(false);
    }
  };

  const submitTicket = async (payload: Parameters<Parameters<typeof CreateTicketFromChatModal>[0]['onSubmit']>[0]) => {
    setBusy(true);
    try {
      await saveTicketFromChat(tab.id, { ...payload, priority: undefined });
      setModalOpen(false);
      setDraft(null);
    } catch (err) {
      if (!(err instanceof ActionError)) { /* runAction already toasted ActionError */ }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b border-gray-200/50 px-4 py-1.5 dark:border-gray-700/50">
        <button
          type="button"
          onClick={openTicketModal}
          disabled={!canCreateTicket}
          className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          Create Ticket
        </button>
      </div>
      <AiCostIndicator enabled />
      {/* ...existing pageContext badge, error banner, AiChatMessages, AiChatInput unchanged... */}

      {modalOpen && (
        <CreateTicketFromChatModal
          draft={draft}
          orgName={draft?.orgName ?? null}
          deviceHostname={draft?.deviceHostname ?? null}
          busy={busy}
          onCancel={() => { if (!busy) { setModalOpen(false); setDraft(null); } }}
          onSubmit={submitTicket}
        />
      )}
    </div>
  );
}
```

Keep the existing `<AiContextBadge>` / error / `<AiChatMessages>` / `<AiChatInput>` blocks exactly as they were — only the new toolbar row, the modal, and the imports/hooks are added.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- WorkspaceChatPanel`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the web app**

Run: `pnpm --filter @breeze/web exec tsc --noEmit` (or the repo's web typecheck).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/workspace/WorkspaceChatPanel.tsx apps/web/src/components/workspace/WorkspaceChatPanel.test.tsx
git commit -m "feat(web): wire Create Ticket button into the AI chat panel"
```

---

## Final verification

- [ ] Run the API test suite: `pnpm --filter @breeze/api test -- ai.ticket aiTicketDraft` → all PASS.
- [ ] Run the web test suite: `pnpm --filter @breeze/web test -- CreateTicketFromChatModal WorkspaceChatPanel` → all PASS.
- [ ] Run the shared test suite: `pnpm --filter @breeze/shared test -- tickets.test` → PASS.
- [ ] Typecheck all three packages.
- [ ] **Manual smoke (optional, via the `run` / `feature-testing` skill):** open the web app, start an AI conversation on a device, exchange at least one assistant message, click **Create Ticket**, confirm the modal prefills a plain-English draft, save, and verify the ticket appears with `source = ai` and (for a partner-scope login) a linked time entry.
```
```

## Notes for the executor

- The `postDraft` / `postTicket` / `partnerAuth` / `orgAuth` test helpers in Tasks 3–4 are not spelled out because the exact Hono test harness + auth-injection pattern varies; **copy it from an existing route test** in `apps/api/src/routes/` (e.g. `ai.test.ts` if present, or another `*.test.ts` that exercises an authenticated route) rather than inventing one. `partnerAuth` must have `scope: 'partner'`; `orgAuth` must have `scope: 'organization'`.
- If `apps/web` uses `astro check` rather than `tsc --noEmit` for typechecking, use that (see the `ci_astro_check_and_integration_tests_gotchas` convention).
- Do NOT edit any shipped migration or add a new one — this feature needs no schema change.

# Create Ticket from an AI Conversation — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming) → ready for implementation plan
**Surface:** Web technician AI Agent (WorkspaceChatPanel) only

## Summary

Add a **"Create Ticket"** button to the technician-facing web AI chat panel. Clicking it
uses an LLM to read the conversation transcript and produce a plain-English, customer-readable
draft ticket — a short problem summary, a resolution summary (if the issue was fixed), a
suggested status (open vs. resolved), and a suggested time value. The tech reviews and edits
the draft in a **preview-and-confirm modal**, then saves. On save, the ticket is created
against the conversation's device and org, optionally resolved, and a time entry is logged.

The value: turn an ad-hoc troubleshooting conversation into a properly attributed, billable,
customer-readable ticket in one click — with a human confirmation step before anything is written.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Create flow | **Preview & confirm modal** — AI drafts, tech edits, ticket written only on Save |
| Time source | **Session elapsed time, AI may trim** for idle gaps / non-work chatter |
| Surface scope | **Web technician AI Agent only** (Helper + Excel client-ai deferred) |
| Summary style | **Plain-English, customer-readable** (problem → description, resolution → resolutionNote) |
| Architecture | **Approach A** — dedicated draft + save endpoint pair; reuse `createTicket()` service |

## What already exists (reused, not built)

- `tickets` table already has `source: 'ai'` in `ticketSourceEnum` (`apps/api/src/db/schema/portal.ts`).
- `createTicket()` service accepts `source: 'ai'` via its discriminated union (`apps/api/src/services/ticketService.ts`).
- Ticket statuses include `resolved`; resolving requires a `resolutionNote` (`changeTicketStatusSchema`).
- Full time-tracking subsystem: `timeEntries` table (`ticketId`, `orgId`, `userId`, `durationMinutes`, `isBillable`, `hourlyRate`, `billingStatus`) in `apps/api/src/db/schema/timeTracking.ts`.
- `ai_sessions` already persists `orgId` (NOT NULL), `deviceId` (nullable), and `contextSnapshot` (jsonb) — device/customer linkage is free.
- `ai_messages` holds the transcript to summarize.
- The `manage_tickets` AI tool already performs an `action:'create'` with `source:'ai'` — the save path reuses the same `createTicket()` service, so no logic is duplicated.
- Org/site access guards (`auth.canAccessOrg`, `requirePermission(TICKETS_WRITE)`) already exist.

**No new table → no RLS migration.** Writes land in `tickets` and `timeEntries`, both already RLS-covered.

## What is net-new

1. Two endpoints in `apps/api/src/routes/ai.ts` (draft + save).
2. One transcript-summarization service (`apps/api/src/services/aiTicketDraft.ts`) — there is no existing chat-transcript summarizer today.
3. `CreateTicketFromChatModal.tsx` React component.
4. A toolbar "Create Ticket" action in `WorkspaceChatPanel.tsx`.
5. Two `workspaceStore` actions.

## Data flow

```
[Create Ticket button in WorkspaceChatPanel]
        │ click (disabled until ≥1 assistant message)
        ▼
workspaceStore.draftTicketFromSession(tabId)
        │ POST /ai/sessions/:id/ticket-draft
        ▼
API: load ai_messages → LLM summarization → return DRAFT (nothing written)
        │ { subject, problemSummary, resolutionSummary, wasFixed,
        │   suggestedStatus, suggestedTimeMinutes,
        │   orgId, orgName, deviceId, deviceHostname }
        ▼
[CreateTicketFromChatModal] renders draft, all fields editable
        │ tech edits + clicks Save
        │ POST /ai/sessions/:id/ticket
        │   { subject, description, resolutionNote?, status,
        │     timeMinutes, billable, priority? }
        ▼
API (one transaction):
   createTicket({ orgId, deviceId, subject, description, priority,
                  source: 'ai' }, actor)
   → if status === 'resolved': apply resolve transition + resolutionNote
   → insert timeEntry(ticketId, orgId, userId, durationMinutes, isBillable)
   → return { data: ticket }
        ▼
Toast "Ticket #NNNN created" + link; modal closes
```

`orgId` and `deviceId` are always taken from the **session row server-side**, never from the
client payload — a client cannot smuggle a cross-tenant device/org into the ticket.

## Endpoint 1 — `POST /ai/sessions/:id/ticket-draft`

- **Guards:** session exists and `auth.canAccessOrg(session.orgId)`; `requirePermission(TICKETS_WRITE)`.
- **Behavior:** load the session's `ai_messages` (user/assistant/tool_result roles), compute elapsed
  minutes (`session.createdAt → now`) as the time ceiling, call the summarizer, return the draft.
  **No DB writes.**
- **Thin transcript:** if there is not enough conversation to summarize (e.g. no assistant turn),
  return `422` with a friendly message the modal surfaces as "not enough conversation to draft a ticket."
- **Response:** the draft object (see contract below) plus resolved `orgName` / `deviceHostname` for display.

## Endpoint 2 — `POST /ai/sessions/:id/ticket`

- **Guards:** same as above + `zValidator('json', createTicketFromChatSchema)`.
- **`createTicketFromChatSchema`** (new, `packages/shared/src/validators/`):
  `{ subject (1–255), description (problem summary), resolutionNote? (required when status==='resolved'),
     status: 'open' | 'resolved', timeMinutes (int ≥ 0), billable (bool), priority? }`.
  Cross-field rule mirrors `changeTicketStatusSchema`: `resolutionNote` required when `status === 'resolved'`.
- **Behavior (single transaction):**
  1. `createTicket({ orgId: session.orgId, deviceId: session.deviceId, subject, description, priority, source: 'ai' }, actorFrom(c))`.
  2. If `status === 'resolved'`: apply the resolve transition (sets `resolvedAt`, `resolutionNote`) — reuse the same path `changeTicketStatus`/`updateTicket` uses so SLA/comment side effects stay consistent.
  3. Insert a `timeEntry`: `{ ticketId, orgId: session.orgId, userId: auth.user.id, durationMinutes: timeMinutes, isBillable: billable, description: 'Logged from AI conversation' }`. Skip if `timeMinutes === 0`.
  4. Return `{ data: ticket }`.
- **Atomicity:** all in one DB transaction so a failure never leaves a half-created ticket.

## Summarization contract — `apps/api/src/services/aiTicketDraft.ts`

One LLM call (reuse the agent SDK infra) with a strict prompt that must return JSON validated
against a Zod schema:

```ts
{
  subject: string,            // ≤120 chars
  problemSummary: string,     // plain-English, no jargon / commands / tool output
  resolutionSummary: string,  // "" if not fixed
  wasFixed: boolean,          // → suggestedStatus 'resolved' vs 'open'
  suggestedTimeMinutes: number
}
```

**Prompt inputs:** the transcript, session `contextSnapshot`, and the computed elapsed minutes
(passed as the ceiling / seed for `suggestedTimeMinutes`).

**Prompt instructions:**
- Write for a **non-technical reader**; the resolution text is shown to the customer — no jargon,
  no command output, no internal tool names.
- Only set `wasFixed: true` if the conversation shows the issue was actually **verified** fixed
  (not merely attempted).
- Seed `suggestedTimeMinutes` from the elapsed ceiling but trim it if the transcript shows long
  idle gaps or non-work chatter; never exceed the elapsed ceiling.

**Failure handling:** on invalid JSON, retry once, then return `422`. The route maps summarizer
failure to a friendly modal state (see Error Handling).

## UI

- **`apps/web/src/components/workspace/WorkspaceChatPanel.tsx`** — add a small toolbar row near
  `AiContextBadge` with a **"Create Ticket"** button, disabled until there is ≥1 assistant message.
  Clicking opens the modal in a `drafting` (spinner) state while the draft endpoint runs.
- **`apps/web/src/components/ai/CreateTicketFromChatModal.tsx`** (new) — matches the approved mockup:
  read-only Org / Device chips; editable **Subject**, **Problem** (description), **Resolution**;
  an **Open / Resolved** radio (selecting Resolved makes Resolution required); **Time** (number, minutes)
  + **Billable** checkbox; optional **Priority**. Save is wrapped in `runAction`
  (`apps/web/src/lib/runAction.ts`) per the repo's mutation-feedback rule.
- **`apps/web/src/stores/workspaceStore.ts`** — `draftTicketFromSession(tabId)` and
  `saveTicketFromSession(tabId, payload)` actions.

## Error handling

- **Thin transcript** → `422`; modal shows "not enough conversation to draft a ticket."
- **LLM failure** → toast; modal stays open with empty editable fields so the tech can still write
  the ticket manually (graceful degradation, not a dead end).
- **Resolve without note** → blocked client-side in the modal (Save disabled) AND server-side by
  `createTicketFromChatSchema`, matching `changeTicketStatusSchema`.
- **Save failure** → surfaced by `runAction` (which also treats `{success:false}` 200 bodies as failures).

## Tenancy / security

- `orgId` and `deviceId` come from the session row server-side; the client cannot override them.
- The save route re-checks `auth.canAccessOrg(session.orgId)` and `requirePermission(TICKETS_WRITE)`.
- No new table; `tickets` and `timeEntries` RLS already covers these writes.

## Testing

- **API route tests** (`apps/api/src/routes/ai.*.test.ts` or sibling):
  - draft returns a non-persisted object (no ticket row created);
  - save creates a ticket with `source:'ai'` **and** a linked `timeEntry`;
  - resolved path sets `resolvedAt` + `resolutionNote`;
  - `timeMinutes === 0` creates no time entry;
  - a session belonging to another org is rejected `403`;
  - thin transcript returns `422`.
- **Summarizer unit test** (`aiTicketDraft.test.ts`): mocked LLM; asserts Zod schema conformance,
  `wasFixed → suggestedStatus` mapping, and that `suggestedTimeMinutes` never exceeds the elapsed ceiling.
- **Web tests**: modal renders the draft; Resolved requires Resolution before Save enables; Save
  calls the store action with the edited payload.
- Follow `breeze-testing` conventions (Drizzle mocks, co-located test files).

## Scope guardrails (YAGNI — explicitly out of v1)

- Web technician AI Agent only (Breeze Helper and Excel client-ai deferred).
- Button-triggered only — the agent does **not** autonomously offer to create a ticket.
- No auto-population of category / assignee / SLA — the tech sets those on the ticket afterward.
- No editing/attaching to an existing ticket from chat — create-only.

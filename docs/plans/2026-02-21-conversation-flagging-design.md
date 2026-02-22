# Conversation Flagging & Auto-Flag on Tool Failures

**Date**: 2026-02-21
**Status**: Approved
**Motivation**: The AI Brain's `manage_services` tool had a payload key mismatch that caused every service restart to fail silently. There was no way to surface or review these failures without manually inspecting logs. This feature adds both manual flagging (by any user) and automatic flagging (on tool failures) so broken conversations are immediately visible to admins.

---

## Schema Changes

Add three nullable columns to `ai_sessions`:

```sql
ALTER TABLE ai_sessions
  ADD COLUMN flagged_at TIMESTAMPTZ,
  ADD COLUMN flagged_by UUID REFERENCES users(id),
  ADD COLUMN flag_reason TEXT;

CREATE INDEX ai_sessions_flagged_at_idx ON ai_sessions (flagged_at) WHERE flagged_at IS NOT NULL;
```

- `flagged_at`: non-null means flagged. Partial index keeps scans fast.
- `flagged_by`: the user who manually flagged. NULL for auto-flags.
- `flag_reason`: free text. Auto-flags use format `"Tool failed: <toolName> — <errorMessage>"`.

Update Drizzle schema in `apps/api/src/db/schema/ai.ts` to add the three columns to the `aiSessions` table definition.

---

## Auto-Flag Trigger

In `apps/api/src/services/streamingSessionManager.ts`, inside the `postToolUse` callback, after a tool execution completes with `status: 'failed'`:

```
if tool execution failed AND session not already flagged:
  UPDATE ai_sessions
  SET flagged_at = NOW(),
      flag_reason = 'Tool failed: {toolName} — {errorMessage}'
  WHERE id = sessionId AND flagged_at IS NULL
```

The `WHERE flagged_at IS NULL` ensures only the first failure flags the session. Subsequent failures don't overwrite the original flag.

---

## API Endpoints

### `POST /ai/sessions/:id/flag`

- Auth: any authenticated user who owns the session (or admin)
- Body: `{ reason?: string }`
- Sets `flagged_at = NOW()`, `flagged_by = auth.user.id`, `flag_reason = reason`
- If already flagged, updates `flag_reason` and `flagged_by` (user re-flagging with a different reason)
- Returns `{ session: { id, flaggedAt, flaggedBy, flagReason } }`

### `DELETE /ai/sessions/:id/flag`

- Auth: partner or system scope only (admins reviewing flagged conversations)
- Clears `flagged_at`, `flagged_by`, `flag_reason` to NULL
- Returns `{ session: { id, flaggedAt: null } }`

### `GET /ai/admin/sessions` (existing — add filter)

- Add `?flagged=true` query parameter
- When set, adds `WHERE flagged_at IS NOT NULL` to the query
- Include `flaggedAt`, `flaggedBy`, `flagReason` in the response projection

### `GET /ai/sessions/:id` (existing — include flag data)

- Include `flaggedAt`, `flaggedBy`, `flagReason` in the session response so the frontend can show flag state.

---

## Frontend

### Chat Sidebar Header

Add a flag icon button to `AiChatSidebar.tsx` in the header bar (next to history/new conversation buttons):

- Unflagged: outlined flag icon, muted color
- Flagged: filled flag icon, amber/orange color
- Click opens a small popover with:
  - Optional reason text input (placeholder: "What went wrong?")
  - "Flag Conversation" button
- If already flagged: shows current reason and a "Remove Flag" option (admin only)

### Admin Sessions Dashboard

In the admin sessions table (accessible via `GET /ai/admin/sessions`):

- Add a "Flagged" column showing a flag badge with the reason as a tooltip
- Add a filter toggle: "Show flagged only"
- Flagged rows get a subtle amber left border for visual scanning
- Clicking a flagged session opens the full conversation history for review

---

## What This Does NOT Include

- No message-level flagging — session-level is sufficient for debugging tool failures
- No notification system — admins check the dashboard on their own cadence
- No flagging categories or severity levels — free-text reason is enough
- No resolution workflow beyond clearing the flag — keep it simple
- No flag history/log — the current flag state is sufficient

---

## Implementation Sequence

1. Schema: Add columns to `ai.ts`, write SQL migration
2. API: Add flag/unflag endpoints, update admin sessions query
3. Auto-flag: Add trigger in `streamingSessionManager.ts` postToolUse callback
4. Frontend: Flag button in sidebar, flagged filter in admin dashboard
5. Tests: Flag/unflag endpoints, auto-flag on tool failure, admin filter

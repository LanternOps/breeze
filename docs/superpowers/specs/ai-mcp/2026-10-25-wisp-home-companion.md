---
parent_spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
supersedes: §17.2 of the parent spec (the Wisp home as a section grid)
status: approved by Todd 2026-10-25 (impeccable shape interview; decisions D1–D3 below)
---

# Wisp home as a companion surface ("the conversation is the page")

## 1. Why

The W08 home (`/wisp`) is a two-column grid of cards (grant header, brief, needs-you, activity on the left; a boxed "Talk to Wisp" chat and links on the right). It reads as a dashboard with a chat beside it. Wisp's product truth is the opposite: one person, one companion, one continuous thread, a brief every morning and nudges in between. The reference is Codex's "Your dot": a single conversation at reading width, Wisp speaking unprompted inside it, a small identity rail at the right, one composer at the bottom. Dot also hands work to sub-agents whose conversations you can open; Wisp has specialists, which are the same thing.

Two defects seen on the stack ride along: every tool call renders as its own card preceded by an empty assistant row (an avatar with nothing beside it), so a six-check sweep costs a screen of scroll; and this is the same message list Breeze AI (`/ai/chat`) and the docked panel use, so the fix lands there too.

## 2. Decisions (Todd, 2026-10-25)

- **D1 Proactive output lives in the thread.** The morning brief, concern nudges and the digest appear inside the conversation as time-stamped posts from Wisp, interleaved with chat. Backend contract in §6.
- **D2 User in a bubble, Wisp as prose.** The user's messages sit right-aligned in a tinted bubble. Wisp's replies run full width with no avatar and no bubble, like ChatGPT and Claude, because sweeps and tables read badly in bubbles.
- **D3 Scope = the Wisp home layout plus the shared chat kit.** The centered column, rail and composer are Wisp-only. Message rows, tool-activity folding and the composer are `AiChatMessages` / `AiChatInput`, so the docked panel, `/ai/chat` and the run detail transcript pick up the same look instead of diverging. Tool-call folding in Breeze AI was already on Todd's list.

## 3. Mode and audience

Operate mode with a conversational topology. A partner-scope tech or owner opens `/wisp` a few times a day, often from a nudge: what did Wisp notice, what is waiting on me, let me talk to it. Success: the first viewport shows the newest thing Wisp said and the composer under it, with the needs-you count visible in the rail, and nothing to scan.

## 4. The surface

### 4.1 Regions

Inside the dashboard shell, three regions:

1. **Thread column**, centered, reading width (`max-w-3xl`), fills the height below the shell header; the message list owns the scroll; the composer is anchored at its bottom.
2. **Rail**, right, sticky, 20rem at `lg`, 22rem at `xl`:
   - Identity card: the Wisp mark, the name, a state line ("Active", "Paused", "Ended", or the live "Checking Acme…" line), the scope chip, then the existing grant controls (status, refresh, settings, turn off, widening notice, spend meter, pause/resume). Existing `WispThreadHeader` body and test ids are kept.
   - Needs your attention: approvals first, the existing concern rows and actions; count in the header.
   - Workers: running and recent specialist runs (activity kind `specialist`), each opening `/ai-agents/runs/:id`; five rows and "All runs".
   - Linked items: the existing chips and picker.
   - Activity: collapsed to its header by default (the posts carry the narrative); expands in place to the existing list.
   - Footer links: All chats (`/ai/chat`), Memory (`/settings/wisp-memory`).
   Below `lg` the rail collapses to a status strip under the shell header (state line, needs-you count, a Details button) that opens the rail in the shared `Drawer`.
3. **Composer**: one rounded field, placeholder "Message Wisp", a plus button on the left (Link an item), the send button inside the field at the right; a stop button while streaming. Enter sends, Shift+Enter inserts a newline, Cmd/Ctrl+Enter still sends; an IME composition Enter never sends.

The page `h1` goes; the identity card carries the name. The non-ready states (locked, start card, partner disabled, load error) keep today's framed layout.

### 4.2 Thread anatomy (shared kit)

- **Time dividers** from each message's `createdAt`: before the first message, and whenever the calendar day changes or the gap exceeds 20 minutes. Labels: "Today 7:22 AM", "Yesterday 6:24 PM", "Oct 21, 9:10 AM" (locale-formatted). Off by default; the Wisp home and `/ai/chat` turn them on; the docked panel does not.
- **Wisp / Breeze AI messages**: prose, no avatar, no bubble. The first assistant message after a user message or a divider carries a small name label ("Wisp" or "Breeze AI"). An assistant row whose content is blank and is not streaming never renders.
- **User messages**: right-aligned, tinted bubble (`bg-primary/10`, dark `bg-primary/20`), at most 75% wide, `break-words`.
- **Tool activity**: consecutive tool rows between two text messages fold into one line listing the tool labels ("Searched devices · Listed organizations · Checked alerts"), with the elapsed time when finished. While streaming the line shows the current call with a spinner and the completed count. A failed call or an approval handoff in the group shows a red count and the group renders expanded. Expanding shows the existing per-call cards (`AiToolCallCard`), so nothing about a call is lost. Expanded state survives re-renders. Approval, plan, flow and run cards never fold; they split a group.
- **Specialists as sub-conversations**: a `launch_specialist` result that was admitted with a `runId` renders as the existing `AiRunCard` (status polled live, "View run" to the run page). Several from one turn stack under one "Handed to N specialists" heading. A refused or needs-approval result stays a plain tool row (the approval card already exists).
- **Posts** (D1): a post renders as a Wisp message with an eyebrow (Morning brief, Nudge, Digest) and the sent time. A brief post shows its sections. A nudge post keeps the concern's actions inline (open, snooze, dismiss, feedback) by reusing the concern row component. Wave 1 renders the latest brief from the home payload as the first item of the thread; wave 2 renders the whole timeline.
- **Empty thread** (new grant): a welcome post ("I'm looking around. Your first brief arrives each morning once I have had a look.") and four suggestion chips above the composer, replacing the six generic quick actions on this surface only.
- **Paused / ended**: the composer is replaced by the existing one-line notice.

### 4.3 States and ranges

Locked, start card, partner disabled, load error, stale polls (rail state line), bind failed with retry, streaming, pending approval, pending plan, budget exhausted (meter destructive with Raise), widening available (primary Refresh in the rail). Needs-you 0–50, links 0–50, specialist runs 0–many (rail shows five), thread 0–thousands of messages (page of 50 in wave 2).

### 4.4 Anti-goals

No second chat-list sidebar (one thread per grant; the nav already pins Wisp). No cards inside cards. No per-row avatars. No gradients, glass or shadows for elevation. No mobile app changes. The mobile DESIGN.md's teal palette is not imported; the web uses its own tokens (Plus Jakarta Sans, `primary` / `card` / `muted` / `border`).

## 5. Waves

- **Wave 1, surface (client only).** The kit restyle (rows, dividers, folding, run cards, composer), the Wisp home layout (column, rail, strip, welcome), the thread page on the same layout, locales, docs, e2e. The latest brief comes from the existing `GET /wisp/home` payload. Ships on its own and is visible on a stack immediately.
- **Wave 2, timeline (API + web).** The thread timeline read that merges every attached session's messages with the proactive posts, the post component reading from it, "Load earlier", and nudge posts with inline concern actions. Contract in §6.

## 6. Backend contract (wave 2)

Facts on main: a thread (`wisp_threads`, one per grant) owns many chat sessions through `wisp_thread_sessions`; messages are `ai_messages` rows per session. Briefs, nudges and digests are delivered by `notifyUser` as `user_notifications` rows with `metadata.grantId`, `metadata.threadId`, `metadata.concernId`, `metadata.brief` (sections, brief only) and a `dedupe_key` (`wisp.brief:…`, `wisp.nudge:…`, `wisp.digest:…`), then pushed. The activity timeline (`listActivity`) is already a derived keyset union that includes those notification rows.

Two candidate contracts went to the advisor quorum (Codex, xhigh, read-only, 2026-10-25):

- **A. Derived timeline, no new table.** `GET /api/v1/wisp/thread/:id/timeline?cursor&limit` (newest first, the activity cursor style) returning `message` items (all attached sessions' `ai_messages`, each session's org inside the grant's live ceiling, the same DTO as session history plus `sessionId`) and `post` items (`user_notifications` where `metadata->>'grantId'` is the grant: `postKind` from the dedupe key prefix, title, message, link, brief sections, concernId, read, createdAt). Risks: `DELETE /notifications` (clear all) erases posts; a future retention job truncates history; no index on the metadata filter; a post that is not a notification has nowhere to go.
- **B. `wisp_thread_posts` table** written at the single in-app delivery site, RLS forced, registered in cascade, merge and export; the timeline unions it with messages. Immune to notification deletion; a second write and a backfill.

**Verdict: B.** Codex chose the posts table and the author accepted it on the merits: with A, a user whose in-app channel is off would have no history at all (the in-app write is skipped), notification deletion destroys rows, and budget notices also go through the delivery primitive so a post needs an explicit kind. Adjustments adopted: the post is written in `notifyUser`'s database phase regardless of channel; when the in-app channel is on, notification and post are written in one system-context callback, commit before push; `notification_id` is nullable with `ON DELETE SET NULL`; backfill from surviving notifications by `metadata.wispThreadId`; the keyset is `(created_at ms-truncated, source, id)` with the activity timeline's UTC rule; `excludeSessionId` stays because streaming ids and persisted ids differ. Not built now, filed as a follow-up: historical scope leakage across sessions (today's single-session history has the same property). Details and task breakdown: `docs/superpowers/plans/ai-mcp/2026-10-25-wisp-companion-w02-timeline.md`.

Either way: the live session's messages come from the web store, everything older and every post from the timeline; posts arriving while the page is open are picked up by the existing 30 s home poll.

## 7. Untouched

Grant, step-up and MFA flows; approval cards; concern semantics, backoff and quiet hours; entitlement and lock states and their copy; nudge preferences; mobile; e2e test ids on the surviving elements (`wisp-home`, `wisp-home-thread`, `wisp-needs-you`, `wisp-links-panel`, `wisp-links-add`, `wisp-link-chip`, `wisp-entity-picker`, `wisp-picker-search`); hash deep links (`#needs-you`, `#links`, `#activity`, `#thread`, `#concern=<id>`), which now target the rail sections.

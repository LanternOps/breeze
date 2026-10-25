---
tracking_issue: LanternOps/breeze#9840
plan: docs/superpowers/plans/ai-mcp/2026-10-23-ai-chat-move-conversations.md
spec: docs/superpowers/specs/ai-mcp/2026-10-21-ai-chat-move-conversations-spec.md
status: TODO — not yet performed
---

# AI chat: move conversations — real-key lab checklist

> **Every row below is `TODO`. W5 (#9845) shipped this checklist unverified.**
> It must be run by hand on a stack with a **real AI provider key** — not the
> orchestrator's blank-key lab, where no turn can run (a send answers 503
> `ai_not_configured` and every attach answers `turn: "unavailable"`). Nothing
> here may be marked PASS from a unit test, a stubbed provider or a seeded row.

## Purpose

Spec §8 lists three live checks owed before release, and plan Task 17 Step 3
names them (a), (b), (c):

- **(a)** Move a device-bound chat mid-turn while it waits on an approval, then approve it from the destination.
- **(b)** A partner user opens an other-org conversation through a deep link — org chip shown, switcher unchanged.
- **(c)** Leave `/workspace` mid-turn and come back — the tab re-attaches.

(b) is idle-path and was verified live by W5's Playwright spec. (a) and (c) need
a running turn. This checklist covers them, plus every other running-turn
behaviour W5 could only prove against the stores (Review Focus 1–4). W1 #9852,
W2 #9996, W3 #10029, W4 #10044 and W5 ship in one release; run this before that
release is tagged.

## What W5 proved by other means

**Unit, real stores, mocked attach stream** —
`apps/web/src/stores/aiConversationHandoff.runningTurn.test.tsx`:

| Id | `it` | Covers |
|---|---|---|
| RT1 | "the tab holds the card with its original deadline before the panel lets go; …" | A1–A3, G1 (deadline carried, not extended) |
| RT2 | "the tab closes only once the panel holds the running turn and its card; …" | A4 |
| RT3 | "cleanup stops both attaches (old frames write nothing); …" | C1 |
| RT4 | "workspace tab: placeholder + 'Joined mid-response' line, …" and "side panel: the same, through adoptSession …" | E1 |
| RT5 | "409 turn_in_progress → no error, bubble dropped, text back in the tab composer, …" | D2 |
| RT6 | "after HANDOFF_TIMEOUT_MS the panel still holds the running turn …" | Review Focus 2 |

Component variant of RT3: `apps/web/src/components/workspace/WorkspacePage.reattach.test.tsx`
("unmount stops both attaches; the next mount re-joins each running turn …").

**E2E, blank-key stack, idle paths** — `e2e-tests/tests/ai-move-conversation.spec.ts`:
legs 1 (panel → workspace), 2 (workspace → panel, both controls, panel open),
3 (History both directions + replace-confirm), 4 (picker), 5 (deep link incl.
leg (b)), 6 (leave and return, idle wiring of (c)), 7 (five-tab cap), 8 (logout).

W1–W3 own the per-surface unit tables (D1 two-browser-tab re-attach is W2's
`aiStore.attach.test.ts` / W3's `workspaceStore.attach.test.ts`; logout is T14).

## Preconditions

- A Breeze stack on this release's build with a **real** provider key configured
  (the AI assistant answers a plain "hello").
- Sign in as the seeded admin, or as a partner user who can reach **at least two
  organizations**.
- A device that is online, with a **device-bound** chat: open the device page,
  open the side panel, ask something about that device.
- A request whose first tool call raises an **approval card** in chat with a
  deadline — e.g. "restart the Print Spooler service on this device" (`execute_command`
  `restart_service`: Tier 3, **supervised**, approved by you in chat; see the
  tier table in `apps/docs/src/content/docs/features/ai.mdx`). Approval mode:
  per-step (the default). The approval timeout is 5 minutes unless changed —
  leave enough time for each row.
- Browser devtools open on the **Network** panel, filtered on `/api/v1/ai/sessions`,
  with "Preserve log" on. A viewport at least 1024 px wide.

## Rows

| # | Row | Steps | Expected | Observed | Status |
|---|---|---|---|---|---|
| A1 | Start a turn that waits on an approval (side panel) | 1. On the device page, open the side panel on the device-bound chat. 2. Send the restart request. | The approval card appears in the panel with **Approve** / **Deny** and its deadline. Network: exactly one `POST …/sessions/<id>/messages`. |  | TODO |
| A2 | Move it while the card is pending | 1. Note the card's deadline. 2. Click **Open in AI Assistant** (panel header). | `/workspace#session=<id>` opens one tab with the same history, the partial reply and the **same** card with the **same** deadline. Network: one `GET …/sessions/<id>`, one `GET …/sessions/<id>/stream` whose first `data:` frame is `attach_state` with `"turn":"running"` and a non-empty `pendingCards`. **No** second `POST …/messages`, **no** `DELETE`. The panel closes; `localStorage['breeze-ai-chat']` holds `"sessionId":null`. |  | TODO |
| A3 | Approve from the destination | Click **Approve** on the card in the tab. | `POST …/sessions/<id>/approve/<executionId>` → 200. The tool runs (the service restarts on the device), the reply completes **in the tab**, the streaming dot on the tab goes away (`done` on the attach). Nothing appears in the panel. |  | TODO |
| A4 | Reverse: move a streaming tab to the panel | 1. In a tab, ask for something long ("list every installed application with its version"). 2. While it streams, click **Continue in side panel** (chat header). | The panel opens with the text so far, then the live tail continues there. The tab is gone. Network: one `GET …/sessions/<id>`, one `GET …/stream`; **no** `DELETE`, **no** second `POST …/messages`. |  | TODO |
| A5 | History move mid-turn | 1. Start a long turn in a tab. 2. Open the side panel → **History**. 3. The row for that conversation is labelled **Open in AI Assistant**; pick it while it streams. | As A4: the panel takes over the running reply; the tab closes; no `DELETE`; one `/stream`. |  | TODO |
| A6 | Picker move mid-turn | 1. Start a long turn in the side panel. 2. On `/workspace`, tab bar **+** → **Open a past conversation**. 3. The row is labelled **Open in side panel**; pick it while it streams. | A tab opens with the running reply and continues it; the panel releases the conversation; no `DELETE`; one `/stream` for the tab. |  | TODO |
| B1 | Other-org deep link (real orgs) | 1. Note the org switcher. 2. Open `/workspace#session=<id of a conversation in another org>`. | A tab opens; its org chip names the other org once the org list loads ("Another organization" until then); the org switcher is unchanged. *(E2E'd idle in W5, leg 5 — re-check with real orgs and a partner user.)* |  | TODO |
| C1 | Leave `/workspace` mid-turn and return | 1. Start a long turn in a tab. 2. Click **Devices** in the sidebar. 3. Wait ~10 s. 4. Click **AI Assistant**. | Each tab re-attaches: one `GET …/stream` per session tab, the running one answers `"turn":"running"`, and the reply continues and completes. **No** second `POST …/messages`. |  | TODO |
| C2 | Reload the panel mid-turn | 1. Start a turn in the side panel that waits on an approval (as A1). 2. Reload the page. 3. Open the side panel. | The panel restores the conversation and attaches: the card (same deadline) and the partial text survive the reload; approving it works. |  | TODO |
| D1 | Two browser tabs on one conversation | 1. Browser tab 1: the conversation in the side panel. 2. Browser tab 2: the same conversation (side panel or `/workspace#session=<id>`), idle. 3. In tab 1, send a message. 4. Watch tab 2. | Tab 2's attach for the previous turn ends without `done` and it re-attaches **once** to the new turn (one extra `/stream`), then follows it to the end. No stuck spinner, no error banner. *(Review Focus 1.)* |  | TODO |
| D2 | Send from the second surface while a turn runs | 1. Start a long turn in browser tab 1. 2. In browser tab 2 (idle on the same conversation), type a message and send. | `POST …/messages` → 409 `turn_in_progress`; no error banner; the typed text is back in tab 2's composer; one `/stream` from tab 2 that joins the running turn. |  | TODO |
| E1 | Join a turn whose output is over 256 KiB | 1. Ask for a very long output (e.g. a full software inventory across many devices, or a long log listing). 2. While it streams, move it (A2 or A4). | The destination shows "Joined mid-response. The full reply appears when it finishes.", then the full reply after `done`, followed by one extra `GET …/sessions/<id>`. |  | TODO |
| F1 | Sign out mid-turn | 1. Start a long turn in a tab, and have another conversation in the side panel. 2. Sign out from the account menu. 3. Sign back in and open `/workspace`. | The streams are aborted (Network: the `/stream` requests end), `breeze-workspace` and `breeze-ai-chat` are gone from localStorage, and the next sign-in shows no tabs and an unbound panel. |  | TODO |
| G1 | The deadline is not extended by a move | 1. As A1, then A2. 2. Do **not** approve. 3. Wait past the deadline shown on the card. | The card expires in the destination at the **original** time (the request stops waiting and never runs), not at "move time + timeout". |  | TODO |

## Evidence to capture

- For A2, A4, C1, D1: a HAR export (or screenshot) of the Network panel showing
  the `/stream` request and its first `attach_state` frame, and the absence of a
  second `POST …/messages` and of any `DELETE`.
- For A2 and G1: screenshots of the card's deadline in the origin and the destination.
- For F1: a screenshot of the Application → Local Storage panel after sign-out.
- The build (`BREEZE_VERSION` / commit) of the stack.

Use synthetic data only. No customer names, hostnames or addresses in the evidence.

## Sign-off

| Field | Value |
|---|---|
| Run by | |
| Date | |
| Stack build | |
| (a) A1–A3 | TODO |
| (b) B1 | TODO |
| (c) C1 | TODO |

The orchestrator runs `close_feature` for feature #9840 only when the §8 rows — A1–A3 (a), B1 (b), C1 (c)
— are PASS, or when Todd decides to close it with them open.

# AI Script Builder — Design Document

**Date:** 2026-02-26
**Branch:** `feature/ai-script-builder`
**Status:** Approved

## Overview

Add an inline AI chat assistant to the script editor that helps users write, improve, and test automation scripts. The AI auto-applies generated code and metadata directly into the editor with one-click revert.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI location | Inline panel in Script Editor | Tight coupling with Monaco editor; no context switch |
| Sessions | Separate script-scoped sessions | Keeps main AI chat clean; conversations tied to scripts |
| Apply mode | Auto-apply with revert | Feels immediate; snapshot-based undo prevents mistakes |
| Tool access | Read context + library + test execution | Context-aware generation plus ability to validate |
| Persona | General assistant with script focus | Flexible but naturally anchored by editor context |
| Budget | Shared org AI budget | Simplest; no separate budget management needed |

## Approach: Dedicated Script AI Service

New `ScriptBuilderService` wrapping the existing AI agent SDK with script-focused system prompt, curated tool subset, and custom SSE endpoint. Separate frontend component (`ScriptAiPanel`) communicates with `ScriptForm` via callback bridge.

### Why Not Alternatives

- **AI Chat Extension (mode-based):** `aiTools.ts` is already ~150KB. Adding conditional mode logic increases coupling and complexity in an already large service.
- **Iframe Isolation:** Over-engineered. `postMessage` API is clunky and duplicates existing chat UI patterns.

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│  Script Form (name, description, category, OS, etc) │
├──────────────────────────────┬──────────────────────┤
│                              │  AI Script Assistant  │
│   Monaco Editor              │  ┌──────────────────┐│
│   (code content)             │  │ Chat messages     ││
│                              │  │ ...               ││
│                              │  │ [Code block with  ││
│                              │  │  Apply indicator] ││
│                              │  ├──────────────────┤│
│                              │  │ Message input     ││
│                              │  └──────────────────┘│
├──────────────────────────────┴──────────────────────┤
│  Parameters | Execution Settings | [Save]           │
└─────────────────────────────────────────────────────┘
```

- Toggle via sparkles icon button (top-right of editor section), keyboard shortcut `Cmd+Shift+I`
- Panel width: `w-96`, collapsible
- Revert button appears after each AI apply with toast notification

## Backend Architecture

### API Routes — `apps/api/src/routes/scriptAi.ts`

Mounted at `/api/ai/script-builder`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/sessions` | Create session (accepts optional `scriptId`, `language`, `osTypes`, `editorSnapshot`) |
| `GET` | `/sessions/:id` | Get session with messages |
| `POST` | `/sessions/:id/messages` | Send message, returns SSE stream |
| `POST` | `/sessions/:id/interrupt` | Interrupt active response |
| `DELETE` | `/sessions/:id` | Close session |
| `POST` | `/sessions/:id/approve/:executionId` | Approve tool execution (test-execute) |

### ScriptBuilderService — `apps/api/src/services/scriptBuilderService.ts`

Wraps existing infrastructure:
- `StreamingSessionManager` for persistent SDK sessions
- `StreamInputController` for follow-up messages
- `SessionEventBus` for SSE streaming
- `aiCostTracker` for shared budget
- `aiGuardrails` for pre/post tool checks

Configures script-specific system prompt and tool whitelist.

### Database Change

Add `type` column to `aiSessions`:
```sql
ALTER TABLE ai_sessions ADD COLUMN type text NOT NULL DEFAULT 'general';
```
Values: `'general'` | `'script_builder'`

No new tables needed.

## Tools (10 total)

### Apply Tools (new, script-builder-only)

| Tool | Tier | Params |
|------|------|--------|
| `apply_script_code` | 1 | `code: string`, `language: ScriptLanguage` |
| `apply_script_metadata` | 1 | Partial `{ name, description, category, osTypes, parameters, runAs, timeoutSeconds }` |

These emit `script_apply` SSE events. The frontend handles them by calling `setValue()` on the form. No DB tool execution record needed.

### Context Tools (existing, read-only)

| Tool | Tier | Purpose |
|------|------|---------|
| `list_devices` | 1 | Find devices to tailor scripts |
| `get_device_details` | 1 | OS, specs, installed software |
| `get_device_alerts` | 1 | Active alerts on a device |
| `list_scripts` | 1 | Search existing script library |
| `get_script_details` | 1 | Read existing script code/metadata |
| `list_script_templates` | 1 | Browse templates |
| `get_script_execution_history` | 1 | Past results for a script |

### Execution Tool (existing, requires approval)

| Tool | Tier | Purpose |
|------|------|---------|
| `execute_script_on_device` | 4 | Test-run current editor content on a device. Creates transient command (no `scriptId` FK). |

## Frontend Architecture

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ScriptAiPanel.tsx` | `components/scripts/` | Chat panel — messages, input, revert button |
| `ScriptAiMessages.tsx` | `components/scripts/` | Renders messages with syntax-highlighted code blocks |
| `ScriptAiInput.tsx` | `components/scripts/` | Text input, send button, Shift+Enter newlines |

### New Store — `stores/scriptAiStore.ts`

Zustand store (same pattern as `aiStore.ts`):

```ts
interface ScriptAiState {
  sessionId: string | null;
  messages: ScriptAiMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  pendingApproval: PendingApproval | null;
  panelOpen: boolean;
  formSnapshot: Partial<ScriptFormValues> | null;

  togglePanel: () => void;
  createSession: (context: ScriptBuilderContext) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  approveExecution: (executionId: string, approved: boolean) => Promise<void>;
  interruptResponse: () => Promise<void>;
  closeSession: () => Promise<void>;
}
```

### ScriptForm Integration

`ScriptForm` gains `enableAi?: boolean` prop (default `true`). When enabled, the editor section becomes a flex row with the AI panel.

Communication via callback bridge:

```ts
interface ScriptFormBridge {
  getFormValues: () => ScriptFormValues;
  setFormValues: (partial: Partial<ScriptFormValues>) => void;
  takeSnapshot: () => void;
  restoreSnapshot: () => void;
}
```

### SSE Event Handling

| Event Type | Frontend Action |
|------------|-----------------|
| `content_delta` | Append to current assistant message |
| `script_apply` | `takeSnapshot()` then `setFormValues()` |
| `tool_use_start` | Show tool call card |
| `approval_required` | Set `pendingApproval` for execute tool |
| `done` | Mark streaming complete |

## System Prompt

```
You are a script-writing assistant for Breeze RMM, an IT management platform.
You help IT professionals write, improve, and test automation scripts.

You have access to tools that let you:
- Write code directly into the script editor (apply_script_code)
- Set script metadata like name, description, OS targets (apply_script_metadata)
- Look up devices, alerts, and installed software to tailor scripts
- Search the existing script library for reference
- Test-run scripts on devices (requires user approval)

When the user asks you to write or modify a script:
1. Ask clarifying questions if the request is ambiguous
2. Use apply_script_code to write the code into the editor
3. Use apply_script_metadata to fill in appropriate metadata
4. Explain what the script does and any assumptions you made

When editing an existing script, prefer targeted modifications over full rewrites.
Always consider error handling, logging, and cross-platform compatibility.
For PowerShell, prefer modern cmdlets. For Bash, ensure POSIX compatibility where possible.
```

Current editor state is appended on each message so the AI sees manual edits.

## Edge Cases

- **Session lifecycle:** One session per editor instance. Closed on navigate-away via `useEffect` cleanup.
- **Revert:** Single-level undo. Snapshot taken before each AI turn's first `script_apply`. Revert restores pre-turn state.
- **Streaming failures:** Error toast + "Resend" button on last user message.
- **SDK timeout:** 3-minute turn timeout. Frontend shows "Response timed out" message.
- **Test execution offline device:** Tool returns error, AI relays to user.
- **Test execution results:** stdout/stderr/exit code displayed in chat. AI can suggest fixes.
- **Budget exhaustion:** Same errors as main AI chat.
- **Permissions:** Script editor access implies script AI access. `execute_script_on_device` checks device access scope.

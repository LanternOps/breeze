/**
 * /client-ai wire types. THE single place event names/payloads appear (D1).
 * SSE names mirror Plan 2's CLIENT_AI_SSE_EVENTS (apps/api/src/routes/clientAi/sse.ts)
 * — the data JSON does NOT repeat the type; the client discriminates on the
 * SSE `event:` field (see Contract reconciliation).
 */

export type CellValue = string | number | boolean | null;

/**
 * Host tool layer signature: one wire-tool executor. Lives here (host-neutral)
 * so the HostAdapter contract and the Excel dispatcher both reference the same
 * shape without the core depending on the Excel modules.
 */
export type ToolExecutor = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Before/after preview for a mutating tool request (spec §5). The generic union
 * every host's `buildPreview` collapses to: a `grid` carries a real before/after
 * matrix (revertible writes), a `summary` is a one-line description, and `text`
 * carries the full proposed prose (an email draft body) so the user approves the
 * actual content rather than a one-line summary — `before` is set only when an
 * existing draft is being revised. Owned here (host-neutral) — it only
 * references `CellValue`.
 */
export type WritePreview =
  | {
      kind: 'grid';
      toolName: string;
      target: string;
      before: CellValue[][];
      after: CellValue[][];
      changedCount: number;
    }
  | { kind: 'summary'; toolName: string; target: string; description: string }
  | { kind: 'text'; toolName: string; target: string; before?: string; after: string };

export type DlpRedaction = { rule: string; count: number; location: string };
export type TurnUsage = { inputTokens: number; outputTokens: number; costCents: number };

export type ToolResultStatus = 'success' | 'error' | 'rejected';
export type ToolCompletedStatus = ToolResultStatus | 'timeout';

export const CLIENT_AI_SSE_EVENTS = [
  'message_delta',
  'tool_request',
  'tool_completed',
  'turn_complete',
  'session_error',
  'ping',
] as const;

export type ClientAiStreamEvent =
  | { type: 'message_delta'; text: string }
  | {
      type: 'tool_request';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      mutating: boolean;
    }
  | {
      type: 'tool_completed';
      toolUseId: string;
      toolName: string;
      status: ToolCompletedStatus;
      redactions: DlpRedaction[];
      blockReason: string | null;
    }
  | { type: 'turn_complete'; usage: TurnUsage | null }
  | { type: 'session_error'; message: string }
  | { type: 'ping' };

export type WorkbookContextKind = 'selection' | 'sheet' | 'none';

/** Per-message context chip payload (Plan 2 workbookContextSchema). */
export type WorkbookContext = {
  kind: WorkbookContextKind;
  address?: string;
  sheetName?: string;
  cells?: CellValue[][];
  /**
   * Linear-text context (Word and other grid-less hosts). Additive: Excel
   * never sets it — its context chip is grid-shaped (`cells`/`address`).
   */
  text?: string;
};

/**
 * Office hosts the add-in can run inside. Threaded from the per-host pane shell
 * so the server serves the matching tool registry + system prompt — without it
 * the server defaults to 'excel'.
 */
export const CLIENT_HOSTS = ['excel', 'word', 'powerpoint', 'outlook'] as const;
export type ClientHost = (typeof CLIENT_HOSTS)[number];

export type WriteMode = 'readwrite' | 'readonly';
/** Org gate for pane auto-apply (server-authoritative). 'ask' = no auto-apply. */
export type WriteApproval = 'ask' | 'allow_auto';

/** POST /client-ai/sessions response — carries the effective write governance. */
export type SessionCreated = {
  sessionId: string;
  writeMode: WriteMode;
  writeApproval: WriteApproval;
};

export type SendMessageBody = { content: string; workbookContext?: WorkbookContext };

export type ToolResultBody = { toolUseId: string; status: ToolResultStatus; output?: unknown };

export type ClientAiTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  body: string;
};

export type SessionSummary = {
  id: string;
  status: string;
  title: string | null;
  workbookName: string | null;
  model: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  createdAt: string;
  lastActivityAt: string | null;
};

/**
 * Body of POST /client-ai/sessions — tags the session with the open workbook
 * and (optionally) the host so the server serves the matching registry/prompt.
 */
export type CreateSessionBody = { workbookName?: string; host?: ClientHost };

/** One row in the per-user conversation history list (GET /client-ai/sessions). */
export type SessionListItem = {
  id: string;
  title: string | null;
  workbookName: string | null;
  status: string;
  createdAt: string;
  lastActivityAt: string | null;
  updatedAt: string;
  messageCount: number;
};

export type SessionMessage = {
  id: string;
  role: string;
  content: string | null;
  contentBlocks: unknown;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  toolUseId: string | null;
  createdAt: string;
};

export type SessionHistory = { session: SessionSummary; messages: SessionMessage[] };

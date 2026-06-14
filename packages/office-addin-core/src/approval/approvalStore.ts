/**
 * Pending mutating-tool queue. The dispatcher (Task 7) enqueues; the
 * WritePreviewCard resolves via apply()/reject(). Snapshots are immutable and
 * subscribe() fires on every change — useSyncExternalStore-compatible.
 */
import type { CellValue, ClientAiStreamEvent, ToolResultBody, WritePreview } from '../api/types';

/** One tool_request event off the SSE stream (host-neutral discriminant). */
export type ToolRequest = Extract<ClientAiStreamEvent, { type: 'tool_request' }>;

/** Shape of the preview builder — injectable so non-Excel hosts can supply their own. */
export type BuildPreview = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<WritePreview>;

/**
 * Host-neutral tool runner: applies one tool and never throws (failures become
 * { status: 'error' }). Injected so the store reuses the same executors as the
 * dispatcher without importing the Excel tool layer.
 */
export type Execute = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ status: 'success' | 'error'; output: unknown }>;

export type PendingApproval = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: WritePreview;
  requestedAt: number;
};

/**
 * One entry in the client-facing "Changes applied" log — the trust/governance
 * record of what the assistant did to this workbook. Newest-first in the panel.
 *
 * `revertible` is true ONLY when a real before-grid was captured (grid previews
 * from write_range / insert_formula). Summary-only tools (create_sheet/table/
 * chart/pivot, format/clear/sort) are recorded as applied-but-not-revertible:
 * we never captured a before-state to restore, so we must not claim we can undo.
 */
export type AppliedChange = {
  id: string;
  toolUseId: string;
  toolName: string;
  /** Sheet-qualified target the change landed on (e.g. "Sheet1!B2:F40"). */
  target: string;
  appliedAt: number;
  /** True only when a before-grid exists and the change can be reverted. */
  revertible: boolean;
  /** Set once the user undoes the change. */
  reverted: boolean;
  /** Pre-change grid (revertible writes only) — what revertChange restores. */
  before?: CellValue[][];
  /** Post-change grid (revertible writes only) — informational. */
  after?: CellValue[][];
};

let changeSeq = 0;
function nextChangeId(): string {
  changeSeq += 1;
  return `chg-${Date.now()}-${changeSeq}`;
}

export type ApprovalDeps = {
  postToolResult: (result: ToolResultBody) => Promise<void>;
  /**
   * Tool runner. REQUIRED — bound to the host's tool layer by the composition
   * root (ChatPane) so apply/auto-apply/revert use the same executors as the
   * dispatcher. The store never imports a host tool layer itself.
   */
  execute: Execute;
  /**
   * Preview builder. REQUIRED — the host supplies its own (Excel before/after
   * card, or a non-Excel host's equivalent) via the HostAdapter.
   */
  buildPreview: BuildPreview;
  /**
   * Sink for a FAILED postToolResult (network error, 5xx, or the post-timeout
   * 404 unknown_tool_request). OPTIONAL — when unset, post failures are
   * swallowed (back-compat). The composition root (ChatController) binds this to
   * classify benign-vs-surfaced and route to the pane banner + a log. Without
   * it a rejected post would vanish: no banner, no log, and the parked SDK turn
   * hangs until the 300s bridge timeout.
   */
  reportPostError?: (err: unknown) => void;
};

export class ApprovalStore {
  private queue: readonly PendingApproval[] = [];
  private listeners = new Set<() => void>();
  /**
   * Pane-local Auto/Ask toggle. Auto means a mutating tool applies the instant
   * it arrives, with NO preview card. Defaults to Ask (false) — and the pane
   * only ever flips this on when the ORG policy is writeApproval='allow_auto'
   * (the server is the real gate; this is the convenience switch).
   */
  private autoApply = false;
  /** Client-facing "Changes applied" log (newest-first). */
  private applied: readonly AppliedChange[] = [];

  constructor(private deps: ApprovalDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Post a tool result to the server, surfacing (not swallowing) a rejected
   * post. A failed post means the model's parked turn never gets its result —
   * left silent it would hang until the 300s bridge timeout. We route the error
   * to `reportPostError` (the pane decides benign-vs-surface + logs); the local
   * Office.js write has already happened, so we don't unwind it.
   */
  private async postResult(result: ToolResultBody): Promise<void> {
    try {
      await this.deps.postToolResult(result);
    } catch (err) {
      this.deps.reportPostError?.(err);
    }
  }

  getPending(): readonly PendingApproval[] {
    return this.queue;
  }

  /** The applied-changes log, newest-first. useSyncExternalStore-compatible. */
  getAppliedChanges(): readonly AppliedChange[] {
    return this.applied;
  }

  /**
   * Record an applied mutation in the change log. Called from BOTH the
   * Apply-card path and the auto-apply path (only when execution succeeded).
   * A 'grid' preview carries before/after → revertible; anything else is logged
   * applied-but-not-revertible.
   */
  private recordApplied(toolUseId: string, preview: WritePreview): void {
    const grid = preview.kind === 'grid' ? preview : null;
    const entry: AppliedChange = {
      id: nextChangeId(),
      toolUseId,
      toolName: preview.toolName,
      target: preview.target,
      appliedAt: Date.now(),
      revertible: grid !== null,
      reverted: false,
      ...(grid ? { before: grid.before, after: grid.after } : {}),
    };
    this.applied = [entry, ...this.applied];
    this.notify();
  }

  isAutoApply(): boolean {
    return this.autoApply;
  }

  setAutoApply(value: boolean): void {
    if (this.autoApply === value) return;
    this.autoApply = value;
    this.notify();
  }

  async enqueue(request: ToolRequest): Promise<void> {
    let preview: WritePreview;
    const buildPreview = this.deps.buildPreview;
    try {
      preview = await buildPreview(request.toolName, request.input);
    } catch (err) {
      // Malformed input (bad address etc.): tell the model now instead of
      // rendering a broken card the user can't reason about. (Same in Auto
      // mode — a write we can't preview is one we won't silently execute.)
      await this.postResult({
        toolUseId: request.toolUseId,
        status: 'error',
        output: { error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    // Auto mode: apply straight through, skipping the queue/card. The write is
    // still executed via Office.js AND reported to the server (recorded/audited
    // exactly like a user-approved Apply) — it's just not gated on a click.
    if (this.autoApply) {
      const run = this.deps.execute;
      const { status, output } = await run(request.toolName, request.input);
      if (status === 'success') this.recordApplied(request.toolUseId, preview);
      await this.postResult({ toolUseId: request.toolUseId, status, output });
      return;
    }
    this.queue = [
      ...this.queue,
      {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        preview,
        requestedAt: Date.now(),
      },
    ];
    this.notify();
  }

  private take(toolUseId: string): PendingApproval | null {
    const found = this.queue.find((p) => p.toolUseId === toolUseId) ?? null;
    if (found) {
      this.queue = this.queue.filter((p) => p.toolUseId !== toolUseId);
      this.notify();
    }
    return found;
  }

  /** Apply → execute via Office.js, then report success/error to the server. */
  async apply(toolUseId: string): Promise<void> {
    const pending = this.take(toolUseId);
    if (!pending) return;
    const run = this.deps.execute;
    const { status, output } = await run(pending.toolName, pending.input);
    if (status === 'success') this.recordApplied(toolUseId, pending.preview);
    await this.postResult({ toolUseId, status, output });
  }

  /** Reject → report 'rejected' WITHOUT executing anything. */
  async reject(toolUseId: string, reason = 'User rejected the change'): Promise<void> {
    const pending = this.take(toolUseId);
    if (!pending) return;
    await this.postResult({ toolUseId, status: 'rejected', output: { reason } });
  }

  /**
   * Undo a logged change by re-writing its captured before-grid back to the
   * target — through the SAME write_range executor the original write used (no
   * duplicated Office.js). This is a user-initiated undo, NOT a model turn, so
   * we do NOT post a tool result. No-op for non-revertible / already-reverted /
   * unknown ids. On success the entry is marked reverted.
   */
  async revertChange(id: string): Promise<void> {
    const entry = this.applied.find((c) => c.id === id) ?? null;
    if (!entry || !entry.revertible || entry.reverted || !entry.before) return;
    const run = this.deps.execute;
    const { status } = await run('write_range', { address: entry.target, cells: entry.before });
    if (status !== 'success') return;
    this.applied = this.applied.map((c) => (c.id === id ? { ...c, reverted: true } : c));
    this.notify();
  }
}

/**
 * Pending mutating-tool queue. The dispatcher (Task 7) enqueues; the
 * WritePreviewCard resolves via apply()/reject(). Snapshots are immutable and
 * subscribe() fires on every change — useSyncExternalStore-compatible.
 */
import { buildWritePreview, type WritePreview } from './buildPreview';
import { executeTool, type ToolRequest } from '../tools/dispatcher';
import type { ToolResultBody } from '../api/types';

export type PendingApproval = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: WritePreview;
  requestedAt: number;
};

export type ApprovalDeps = {
  postToolResult: (result: ToolResultBody) => Promise<void>;
  /** Injectable for tests; defaults to the real Office.js executor. */
  execute?: typeof executeTool;
};

export class ApprovalStore {
  private queue: readonly PendingApproval[] = [];
  private listeners = new Set<() => void>();

  constructor(private deps: ApprovalDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  getPending(): readonly PendingApproval[] {
    return this.queue;
  }

  async enqueue(request: ToolRequest): Promise<void> {
    let preview: WritePreview;
    try {
      preview = await buildWritePreview(request.toolName, request.input);
    } catch (err) {
      // Malformed input (bad address etc.): tell the model now instead of
      // rendering a broken card the user can't reason about.
      await this.deps.postToolResult({
        toolUseId: request.toolUseId,
        status: 'error',
        output: { error: err instanceof Error ? err.message : String(err) },
      });
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
    const run = this.deps.execute ?? executeTool;
    const { status, output } = await run(pending.toolName, pending.input);
    await this.deps.postToolResult({ toolUseId, status, output });
  }

  /** Reject → report 'rejected' WITHOUT executing anything. */
  async reject(toolUseId: string, reason = 'User rejected the change'): Promise<void> {
    const pending = this.take(toolUseId);
    if (!pending) return;
    await this.deps.postToolResult({ toolUseId, status: 'rejected', output: { reason } });
  }
}

import { describe, expect, it, vi } from 'vitest';
import { ApprovalStore, type Execute, type ToolRequest } from './approvalStore';
import type { ToolResultBody, WritePreview } from '../api/types';

function writeRequest(toolUseId = 'tu-w1'): ToolRequest {
  return {
    type: 'tool_request',
    toolUseId,
    toolName: 'write_range',
    input: { address: 'B2', cells: [['hello']] },
    mutating: true,
  };
}

/** A grid preview for write_range — the revertible shape with a real before/after. */
function gridPreview(before: string[][], after: string[][]): WritePreview {
  return {
    kind: 'grid',
    toolName: 'write_range',
    target: 'Sheet1!B2',
    before,
    after,
    changedCount: 1,
  };
}

/**
 * Default fakes for the two required host deps. `execute` succeeds; `buildPreview`
 * returns a write_range grid by default. Both are vi.fn so callers can assert on
 * calls / override per-test. No Office mock — the store is host-clean.
 */
function makeStore(overrides: {
  execute?: Execute;
  buildPreview?: (toolName: string, input: Record<string, unknown>) => Promise<WritePreview>;
  postToolResult?: (result: ToolResultBody) => Promise<void>;
  reportPostError?: (err: unknown) => void;
} = {}) {
  const postToolResult = vi.fn<(result: ToolResultBody) => Promise<void>>(
    overrides.postToolResult ?? (async () => undefined),
  );
  const reportPostError = overrides.reportPostError ?? vi.fn();
  const execute: Execute =
    overrides.execute ??
    vi.fn(async () => ({
      status: 'success' as const,
      output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
    }));
  const buildPreview =
    overrides.buildPreview ??
    vi.fn(async (_toolName: string, input: Record<string, unknown>) =>
      gridPreview([['']], (input.cells as string[][]) ?? [['hello']]),
    );
  const store = new ApprovalStore({ postToolResult, execute, buildPreview, reportPostError });
  return { store, postToolResult, execute, buildPreview, reportPostError };
}

describe('ApprovalStore', () => {
  it('enqueue builds a preview, exposes an immutable snapshot, and notifies subscribers', async () => {
    const { store, buildPreview } = makeStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getPending().length));
    const before = store.getPending();
    await store.enqueue(writeRequest());
    expect(buildPreview).toHaveBeenCalledWith('write_range', { address: 'B2', cells: [['hello']] });
    expect(store.getPending()).toHaveLength(1);
    expect(store.getPending()).not.toBe(before); // new snapshot reference
    expect(store.getPending()[0]).toMatchObject({
      toolUseId: 'tu-w1',
      toolName: 'write_range',
      preview: { kind: 'grid', target: 'Sheet1!B2' },
    });
    expect(seen).toEqual([1]);
  });

  it('apply executes the tool and posts the success result', async () => {
    const { store, postToolResult, execute } = makeStore();
    await store.enqueue(writeRequest());
    await store.apply('tu-w1');
    expect(execute).toHaveBeenCalledWith('write_range', { address: 'B2', cells: [['hello']] });
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w1',
      status: 'success',
      output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  it('apply posts status:error when execution fails', async () => {
    const execute: Execute = vi.fn(async () => ({
      status: 'error' as const,
      output: { error: 'A worksheet with this name already exists.' },
    }));
    const buildPreview = vi.fn(async (toolName: string) => ({
      kind: 'summary' as const,
      toolName,
      target: 'Sheet1',
      description: 'Create a new sheet named "Sheet1"',
    }));
    const { store, postToolResult } = makeStore({ execute, buildPreview });
    await store.enqueue({
      type: 'tool_request',
      toolUseId: 'tu-w2',
      toolName: 'create_sheet',
      input: { name: 'Sheet1' }, // already exists → executor error
      mutating: true,
    });
    await store.apply('tu-w2');
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w2',
      status: 'error',
      output: { error: expect.stringContaining('already exists') },
    });
  });

  it('reject posts status:rejected WITHOUT executing', async () => {
    const { store, postToolResult, execute } = makeStore();
    await store.enqueue(writeRequest('tu-w3'));
    await store.reject('tu-w3');
    expect(execute).not.toHaveBeenCalled(); // untouched
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w3',
      status: 'rejected',
      output: { reason: 'User rejected the change' },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  describe('auto-apply mode', () => {
    it('defaults to Ask: enqueue parks in the queue and does NOT execute', async () => {
      const { store, execute } = makeStore();
      expect(store.isAutoApply()).toBe(false);
      await store.enqueue(writeRequest('tu-auto0'));
      expect(store.getPending()).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled(); // untouched
    });

    it('in Auto mode enqueue applies immediately WITHOUT queuing a preview card', async () => {
      const { store, postToolResult, execute } = makeStore();
      store.setAutoApply(true);
      expect(store.isAutoApply()).toBe(true);
      await store.enqueue(writeRequest('tu-auto1'));
      // No card parked — it was applied straight through.
      expect(store.getPending()).toHaveLength(0);
      // Still executed (the write landed) and still reported (recorded/audited).
      expect(execute).toHaveBeenCalledWith('write_range', { address: 'B2', cells: [['hello']] });
      expect(postToolResult).toHaveBeenCalledWith({
        toolUseId: 'tu-auto1',
        status: 'success',
        output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
      });
    });

    it('Auto mode still surfaces an unbuildable-input error (no silent execution)', async () => {
      const buildPreview = vi.fn(async () => {
        throw new Error('Unsupported address: not-an-address');
      });
      const { store, postToolResult, execute } = makeStore({ buildPreview });
      store.setAutoApply(true);
      await store.enqueue({
        type: 'tool_request',
        toolUseId: 'tu-auto2',
        toolName: 'write_range',
        input: { address: 'not-an-address', cells: [['x']] },
        mutating: true,
      });
      expect(store.getPending()).toHaveLength(0);
      // A write we can't preview is one we won't silently execute.
      expect(execute).not.toHaveBeenCalled();
      expect(postToolResult).toHaveBeenCalledWith({
        toolUseId: 'tu-auto2',
        status: 'error',
        output: { error: expect.stringContaining('Unsupported address') },
      });
    });

    it('toggling back to Ask resumes parking writes', async () => {
      const { store } = makeStore();
      store.setAutoApply(true);
      store.setAutoApply(false);
      await store.enqueue(writeRequest('tu-auto3'));
      expect(store.getPending()).toHaveLength(1);
    });
  });

  it('uses an injected buildPreview (the HostAdapter seam) instead of the Excel default', async () => {
    const buildPreview = vi.fn(async (toolName: string) => ({
      kind: 'summary' as const,
      toolName,
      target: 'mail-draft',
      description: 'draft reply',
    }));
    const { store } = makeStore({ buildPreview });
    await store.enqueue(writeRequest('tu-host'));
    expect(buildPreview).toHaveBeenCalledWith('write_range', { address: 'B2', cells: [['hello']] });
    expect(store.getPending()[0]).toMatchObject({
      toolUseId: 'tu-host',
      preview: { kind: 'summary', target: 'mail-draft' },
    });
  });

  it('enqueue with unbuildable input posts an immediate error instead of a broken card', async () => {
    const buildPreview = vi.fn(async () => {
      throw new Error('Unsupported address: not-an-address');
    });
    const { store, postToolResult } = makeStore({ buildPreview });
    await store.enqueue({
      type: 'tool_request',
      toolUseId: 'tu-w4',
      toolName: 'write_range',
      input: { address: 'not-an-address', cells: [['x']] },
      mutating: true,
    });
    expect(store.getPending()).toHaveLength(0);
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w4',
      status: 'error',
      output: { error: expect.stringContaining('Unsupported address') },
    });
  });

  describe('postToolResult failure routing', () => {
    it('apply routes a rejected post to reportPostError (does not throw, does not hang)', async () => {
      const boom = new Error('network down');
      const postToolResult = vi.fn(async () => {
        throw boom;
      });
      const reportPostError = vi.fn();
      const { store } = makeStore({ postToolResult, reportPostError });
      await store.enqueue(writeRequest('tu-fail1'));
      // The Apply must resolve (no unhandled rejection) even though the post failed.
      await expect(store.apply('tu-fail1')).resolves.toBeUndefined();
      expect(reportPostError).toHaveBeenCalledWith(boom);
      // The local write still happened and was recorded — only the post failed.
      expect(store.getAppliedChanges()).toHaveLength(1);
    });

    it('reject routes a rejected post to reportPostError', async () => {
      const boom = new Error('5xx');
      const postToolResult = vi.fn(async () => {
        throw boom;
      });
      const reportPostError = vi.fn();
      const { store } = makeStore({ postToolResult, reportPostError });
      await store.enqueue(writeRequest('tu-fail2'));
      await expect(store.reject('tu-fail2')).resolves.toBeUndefined();
      expect(reportPostError).toHaveBeenCalledWith(boom);
    });

    it('auto-apply routes a rejected post to reportPostError', async () => {
      const boom = new Error('timeout');
      const postToolResult = vi.fn(async () => {
        throw boom;
      });
      const reportPostError = vi.fn();
      const { store } = makeStore({ postToolResult, reportPostError });
      store.setAutoApply(true);
      await expect(store.enqueue(writeRequest('tu-fail3'))).resolves.toBeUndefined();
      expect(reportPostError).toHaveBeenCalledWith(boom);
    });

    it('a successful post never calls reportPostError', async () => {
      const { store, reportPostError } = makeStore();
      await store.enqueue(writeRequest('tu-ok'));
      await store.apply('tu-ok');
      expect(reportPostError).not.toHaveBeenCalled();
    });
  });

  describe('applied-changes log', () => {
    it('records a revertible grid entry when a write_range Apply succeeds', async () => {
      // before != after — a real diff to undo.
      const buildPreview = vi.fn(async () => gridPreview([['original']], [['hello']]));
      const { store } = makeStore({ buildPreview });
      const seen: number[] = [];
      store.subscribe(() => seen.push(store.getAppliedChanges().length));

      await store.enqueue(writeRequest('tu-log1'));
      await store.apply('tu-log1');

      const changes = store.getAppliedChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        toolUseId: 'tu-log1',
        toolName: 'write_range',
        target: 'Sheet1!B2',
        revertible: true,
        reverted: false,
      });
      expect(typeof changes[0]!.id).toBe('string');
      expect(typeof changes[0]!.appliedAt).toBe('number');
      // The captured before-grid is the pre-write value (what revert restores).
      expect(changes[0]!.before).toEqual([['original']]);
      expect(changes[0]!.after).toEqual([['hello']]);
      // Subscribers were notified about the new entry.
      expect(seen.at(-1)).toBe(1);
    });

    it('does NOT record an entry when Apply fails (nothing changed)', async () => {
      const execute: Execute = vi.fn(async () => ({
        status: 'error' as const,
        output: { error: 'A worksheet with this name already exists.' },
      }));
      const buildPreview = vi.fn(async (toolName: string) => ({
        kind: 'summary' as const,
        toolName,
        target: 'Sheet1',
        description: 'x',
      }));
      const { store } = makeStore({ execute, buildPreview });
      await store.enqueue({
        type: 'tool_request',
        toolUseId: 'tu-log-err',
        toolName: 'create_sheet',
        input: { name: 'Sheet1' }, // already exists → executor error
        mutating: true,
      });
      await store.apply('tu-log-err');
      expect(store.getAppliedChanges()).toHaveLength(0);
    });

    it('records a non-revertible (summary) entry for tools without a before grid', async () => {
      const buildPreview = vi.fn(async (toolName: string) => ({
        kind: 'summary' as const,
        toolName,
        target: 'Budget',
        description: 'Create a new sheet named "Budget"',
      }));
      const { store } = makeStore({ buildPreview });
      await store.enqueue({
        type: 'tool_request',
        toolUseId: 'tu-log-sheet',
        toolName: 'create_sheet',
        input: { name: 'Budget' },
        mutating: true,
      });
      await store.apply('tu-log-sheet');
      const changes = store.getAppliedChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        toolName: 'create_sheet',
        target: 'Budget',
        revertible: false,
        reverted: false,
      });
      expect(changes[0]!.before).toBeUndefined();
    });

    it('records an entry on the AUTO-APPLY path too', async () => {
      const buildPreview = vi.fn(async () => gridPreview([['original']], [['hello']]));
      const { store } = makeStore({ buildPreview });
      store.setAutoApply(true);
      await store.enqueue(writeRequest('tu-log-auto'));
      const changes = store.getAppliedChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        toolUseId: 'tu-log-auto',
        target: 'Sheet1!B2',
        revertible: true,
      });
      expect(changes[0]!.before).toEqual([['original']]);
    });

    it('does NOT record an applied entry on Reject', async () => {
      const { store } = makeStore();
      await store.enqueue(writeRequest('tu-log-rej'));
      await store.reject('tu-log-rej');
      expect(store.getAppliedChanges()).toHaveLength(0);
    });

    it('revertChange re-writes the captured before-grid and marks the entry reverted', async () => {
      const buildPreview = vi.fn(async () => gridPreview([['original']], [['hello']]));
      const execute: Execute = vi.fn(async () => ({
        status: 'success' as const,
        output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
      }));
      const { store, postToolResult } = makeStore({ buildPreview, execute });
      await store.enqueue(writeRequest('tu-rev1'));
      await store.apply('tu-rev1');

      const id = store.getAppliedChanges()[0]!.id;
      postToolResult.mockClear();
      (execute as ReturnType<typeof vi.fn>).mockClear();
      await store.revertChange(id);

      // Revert re-writes the captured before-grid through the write_range executor.
      expect(execute).toHaveBeenCalledWith('write_range', {
        address: 'Sheet1!B2',
        cells: [['original']],
      });
      // The entry is now marked reverted.
      expect(store.getAppliedChanges()[0]).toMatchObject({ id, reverted: true });
      // Revert is a user-initiated undo, not a model turn — it does NOT post a
      // tool result to the model.
      expect(postToolResult).not.toHaveBeenCalled();
    });

    it('revertChange is a no-op for a non-revertible entry', async () => {
      const buildPreview = vi.fn(async (toolName: string) => ({
        kind: 'summary' as const,
        toolName,
        target: 'Budget',
        description: 'x',
      }));
      const { store } = makeStore({ buildPreview });
      await store.enqueue({
        type: 'tool_request',
        toolUseId: 'tu-rev-sum',
        toolName: 'create_sheet',
        input: { name: 'Budget' },
        mutating: true,
      });
      await store.apply('tu-rev-sum');
      const id = store.getAppliedChanges()[0]!.id;
      await store.revertChange(id);
      expect(store.getAppliedChanges()[0]).toMatchObject({ id, reverted: false });
    });

    it('revertChange is a no-op (no throw) for an unknown id', async () => {
      const { store } = makeStore();
      await expect(store.revertChange('does-not-exist')).resolves.toBeUndefined();
    });

    it('revertChange twice does not double-apply (already reverted is a no-op)', async () => {
      const buildPreview = vi.fn(async () => gridPreview([['original']], [['hello']]));
      const { store, execute } = makeStore({ buildPreview });
      await store.enqueue(writeRequest('tu-rev2'));
      await store.apply('tu-rev2');
      const id = store.getAppliedChanges()[0]!.id;
      await store.revertChange(id);
      (execute as ReturnType<typeof vi.fn>).mockClear();
      // A second revert on an already-reverted entry must NOT execute again.
      await store.revertChange(id);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});

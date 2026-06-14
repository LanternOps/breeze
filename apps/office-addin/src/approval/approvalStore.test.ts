import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { ApprovalStore } from './approvalStore';
import type { ToolRequest } from '../tools/dispatcher';

function writeRequest(toolUseId = 'tu-w1'): ToolRequest {
  return {
    type: 'tool_request',
    toolUseId,
    toolName: 'write_range',
    input: { address: 'B2', cells: [['hello']] },
    mutating: true,
  };
}

function makeStore() {
  const postToolResult = vi.fn(async () => undefined);
  const store = new ApprovalStore({ postToolResult });
  return { store, postToolResult };
}

describe('ApprovalStore', () => {
  it('enqueue builds a preview, exposes an immutable snapshot, and notifies subscribers', async () => {
    const { store } = makeStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getPending().length));
    const before = store.getPending();
    await store.enqueue(writeRequest());
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
    const { store, postToolResult } = makeStore();
    await store.enqueue(writeRequest());
    await store.apply('tu-w1');
    expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['hello']]);
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w1',
      status: 'success',
      output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  it('apply posts status:error when execution fails', async () => {
    const { store, postToolResult } = makeStore();
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
    const { store, postToolResult } = makeStore();
    await store.enqueue(writeRequest('tu-w3'));
    await store.reject('tu-w3');
    expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['']]); // untouched
    expect(postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-w3',
      status: 'rejected',
      output: { reason: 'User rejected the change' },
    });
    expect(store.getPending()).toHaveLength(0);
  });

  describe('auto-apply mode', () => {
    // NOTE: buildPreview reads write_range cells from input.cells
    // (requireCellMatrix(input, 'cells')), so these requests use `cells`. The
    // older tests above use `values` — the pre-existing cells/values param
    // mismatch the prior commit captured. These use the correct key so they
    // exercise the real auto-apply path end-to-end.
    function cellsRequest(toolUseId: string): ToolRequest {
      return {
        type: 'tool_request',
        toolUseId,
        toolName: 'write_range',
        input: { address: 'B2', cells: [['hello']] },
        mutating: true,
      };
    }

    it('defaults to Ask: enqueue parks in the queue and does NOT execute', async () => {
      const { store } = makeStore();
      expect(store.isAutoApply()).toBe(false);
      await store.enqueue(cellsRequest('tu-auto0'));
      expect(store.getPending()).toHaveLength(1);
      expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['']]); // untouched
    });

    it('in Auto mode enqueue applies immediately WITHOUT queuing a preview card', async () => {
      const { store, postToolResult } = makeStore();
      store.setAutoApply(true);
      expect(store.isAutoApply()).toBe(true);
      await store.enqueue(cellsRequest('tu-auto1'));
      // No card parked — it was applied straight through.
      expect(store.getPending()).toHaveLength(0);
      // Still executed (the write landed) and still reported (recorded/audited).
      expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['hello']]);
      expect(postToolResult).toHaveBeenCalledWith({
        toolUseId: 'tu-auto1',
        status: 'success',
        output: { address: 'Sheet1!B2', rowsWritten: 1, columnsWritten: 1 },
      });
    });

    it('Auto mode still surfaces an unbuildable-input error (no silent execution)', async () => {
      const { store, postToolResult } = makeStore();
      store.setAutoApply(true);
      await store.enqueue({
        type: 'tool_request',
        toolUseId: 'tu-auto2',
        toolName: 'write_range',
        input: { address: 'not-an-address', cells: [['x']] },
        mutating: true,
      });
      expect(store.getPending()).toHaveLength(0);
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
      await store.enqueue(cellsRequest('tu-auto3'));
      expect(store.getPending()).toHaveLength(1);
    });
  });

  it('enqueue with unbuildable input posts an immediate error instead of a broken card', async () => {
    const { store, postToolResult } = makeStore();
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

  describe('applied-changes log', () => {
    it('records a revertible grid entry when a write_range Apply succeeds', async () => {
      const { store } = makeStore();
      // Seed the cell so before != after — a real diff to undo.
      getOfficeMock().setValues('Sheet1', 'B2', [['original']]);
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
      const { store } = makeStore();
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
      const { store } = makeStore();
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
      const { store } = makeStore();
      getOfficeMock().setValues('Sheet1', 'B2', [['original']]);
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
      const { store, postToolResult } = makeStore();
      getOfficeMock().setValues('Sheet1', 'B2', [['original']]);
      await store.enqueue(writeRequest('tu-rev1'));
      await store.apply('tu-rev1');
      expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['hello']]);

      const id = store.getAppliedChanges()[0]!.id;
      postToolResult.mockClear();
      await store.revertChange(id);

      // The cell is back to its original value.
      expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['original']]);
      // The entry is now marked reverted.
      expect(store.getAppliedChanges()[0]).toMatchObject({ id, reverted: true });
      // Revert reuses the write_range executor path — it does NOT post a tool
      // result to the model (this is a user-initiated undo, not a model turn).
      expect(postToolResult).not.toHaveBeenCalled();
    });

    it('revertChange is a no-op for a non-revertible entry', async () => {
      const { store } = makeStore();
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
      const { store } = makeStore();
      getOfficeMock().setValues('Sheet1', 'B2', [['original']]);
      await store.enqueue(writeRequest('tu-rev2'));
      await store.apply('tu-rev2');
      const id = store.getAppliedChanges()[0]!.id;
      await store.revertChange(id);
      // Mutate the cell after the revert; a second revert must NOT clobber it.
      getOfficeMock().setValues('Sheet1', 'B2', [['user-typed']]);
      await store.revertChange(id);
      expect(getOfficeMock().getValues('Sheet1', 'B2')).toEqual([['user-typed']]);
    });
  });
});

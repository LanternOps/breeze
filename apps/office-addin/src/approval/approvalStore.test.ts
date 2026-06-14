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
});

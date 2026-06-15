import { describe, expect, it } from 'vitest';
import { excelHostAdapter } from './excel';
import { buildWritePreview } from '../approval/buildPreview';
import { captureWorkbookContext, captureWorkbookName } from '../chat/captureContext';
import { MUTATING_TOOLS, TOOL_EXECUTORS } from '../tools/dispatcher';
import { captureExcelSelectionAddress, subscribeExcelSelectionChanged } from './excelSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

describe('excelHostAdapter', () => {
  it('satisfies the HostAdapter shape', () => {
    // Compile-time + runtime assertion that the adapter has every seam.
    const adapter: HostAdapter = excelHostAdapter;
    expect(typeof adapter.captureContext).toBe('function');
    expect(typeof adapter.captureName).toBe('function');
    expect(typeof adapter.buildPreview).toBe('function');
    expect(typeof adapter.captureSelectionAddress).toBe('function');
    expect(typeof adapter.subscribeSelectionChanged).toBe('function');
    expect(adapter.toolExecutors).toBeTypeOf('object');
    expect(adapter.mutatingTools).toBeInstanceOf(Set);
  });

  it('wires the EXISTING Excel modules (no rewrite)', () => {
    // The adapter must reuse the real implementations, not reimplement them.
    expect(excelHostAdapter.captureContext).toBe(captureWorkbookContext);
    expect(excelHostAdapter.captureName).toBe(captureWorkbookName);
    expect(excelHostAdapter.buildPreview).toBe(buildWritePreview);
    expect(excelHostAdapter.toolExecutors).toBe(TOOL_EXECUTORS);
    expect(excelHostAdapter.mutatingTools).toBe(MUTATING_TOOLS);
    expect(excelHostAdapter.captureSelectionAddress).toBe(captureExcelSelectionAddress);
    expect(excelHostAdapter.subscribeSelectionChanged).toBe(subscribeExcelSelectionChanged);
  });

  it('exposes the full Excel tool layer with mutating tools as a subset', () => {
    // Every mutating tool must have an executor — the adapter can't claim a
    // tool mutates if it can't run it.
    for (const name of excelHostAdapter.mutatingTools) {
      expect(excelHostAdapter.toolExecutors[name]).toBeTypeOf('function');
    }
    // Read tools exist and are NOT in the mutating set.
    expect(excelHostAdapter.toolExecutors['read_range']).toBeTypeOf('function');
    expect(excelHostAdapter.mutatingTools.has('read_range')).toBe(false);
    expect(excelHostAdapter.mutatingTools.has('write_range')).toBe(true);
  });
});

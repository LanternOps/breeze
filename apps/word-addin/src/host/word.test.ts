import { describe, expect, it } from 'vitest';
import { wordHostAdapter } from './word';
import { buildWordPreview } from '../approval/buildPreview';
import { captureWordContext, captureWordDocumentName } from '../chat/captureContext';
import { WORD_MUTATING_TOOLS, WORD_TOOL_EXECUTORS } from '../tools/dispatcher';
import { captureWordSelectionLabel, subscribeWordSelectionChanged } from './wordSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

describe('wordHostAdapter', () => {
  it('satisfies the HostAdapter shape (all 7 members)', () => {
    const adapter: HostAdapter = wordHostAdapter;
    expect(typeof adapter.captureContext).toBe('function');
    expect(typeof adapter.captureName).toBe('function');
    expect(typeof adapter.buildPreview).toBe('function');
    expect(typeof adapter.captureSelectionAddress).toBe('function');
    expect(typeof adapter.subscribeSelectionChanged).toBe('function');
    expect(adapter.toolExecutors).toBeTypeOf('object');
    expect(adapter.mutatingTools).toBeInstanceOf(Set);
  });

  it('wires the EXISTING Word modules (no rewrite)', () => {
    expect(wordHostAdapter.captureContext).toBe(captureWordContext);
    expect(wordHostAdapter.captureName).toBe(captureWordDocumentName);
    expect(wordHostAdapter.buildPreview).toBe(buildWordPreview);
    expect(wordHostAdapter.toolExecutors).toBe(WORD_TOOL_EXECUTORS);
    expect(wordHostAdapter.mutatingTools).toBe(WORD_MUTATING_TOOLS);
    expect(wordHostAdapter.captureSelectionAddress).toBe(captureWordSelectionLabel);
    expect(wordHostAdapter.subscribeSelectionChanged).toBe(subscribeWordSelectionChanged);
  });

  it('exposes the Word tool layer with mutating tools as a subset', () => {
    for (const name of wordHostAdapter.mutatingTools) {
      expect(wordHostAdapter.toolExecutors[name]).toBeTypeOf('function');
    }
    expect(wordHostAdapter.toolExecutors['get_document_overview']).toBeTypeOf('function');
    expect(wordHostAdapter.mutatingTools.has('get_document_overview')).toBe(false);
    expect(wordHostAdapter.mutatingTools.has('insert_text')).toBe(true);
  });

  it('buildPreview returns a summary card for each mutating tool', async () => {
    for (const tool of wordHostAdapter.mutatingTools) {
      const preview = await wordHostAdapter.buildPreview(tool, {
        text: 't',
        location: 'End',
        format: { bold: true },
        query: 'q',
        replace: 'r',
      });
      expect(preview.kind).toBe('summary');
    }
  });
});

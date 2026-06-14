import { describe, expect, it } from 'vitest';
import { powerpointHostAdapter } from './powerpoint';
import { buildPptPreview } from '../approval/buildPreview';
import { capturePptContext, capturePptName } from '../chat/captureContext';
import { POWERPOINT_MUTATING_TOOLS, POWERPOINT_TOOL_EXECUTORS } from '../tools/dispatcher';
import { capturePptSelectionLabel, subscribePptSelectionChanged } from './powerpointSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

describe('powerpointHostAdapter', () => {
  it('satisfies the HostAdapter shape (all 7 members)', () => {
    const adapter: HostAdapter = powerpointHostAdapter;
    expect(typeof adapter.captureContext).toBe('function');
    expect(typeof adapter.captureName).toBe('function');
    expect(typeof adapter.buildPreview).toBe('function');
    expect(typeof adapter.captureSelectionAddress).toBe('function');
    expect(typeof adapter.subscribeSelectionChanged).toBe('function');
    expect(adapter.toolExecutors).toBeTypeOf('object');
    expect(adapter.mutatingTools).toBeInstanceOf(Set);
  });

  it('wires the EXISTING PowerPoint modules (no rewrite)', () => {
    expect(powerpointHostAdapter.captureContext).toBe(capturePptContext);
    expect(powerpointHostAdapter.captureName).toBe(capturePptName);
    expect(powerpointHostAdapter.buildPreview).toBe(buildPptPreview);
    expect(powerpointHostAdapter.toolExecutors).toBe(POWERPOINT_TOOL_EXECUTORS);
    expect(powerpointHostAdapter.mutatingTools).toBe(POWERPOINT_MUTATING_TOOLS);
    expect(powerpointHostAdapter.captureSelectionAddress).toBe(capturePptSelectionLabel);
    expect(powerpointHostAdapter.subscribeSelectionChanged).toBe(subscribePptSelectionChanged);
  });

  it('exposes the PowerPoint tool layer with mutating tools as a subset', () => {
    for (const name of powerpointHostAdapter.mutatingTools) {
      expect(powerpointHostAdapter.toolExecutors[name]).toBeTypeOf('function');
    }
    expect(powerpointHostAdapter.toolExecutors['get_presentation_overview']).toBeTypeOf('function');
    expect(powerpointHostAdapter.mutatingTools.has('get_presentation_overview')).toBe(false);
    expect(powerpointHostAdapter.mutatingTools.has('add_slide')).toBe(true);
  });

  it('buildPreview returns a summary card for each mutating tool', async () => {
    for (const tool of powerpointHostAdapter.mutatingTools) {
      const preview = await powerpointHostAdapter.buildPreview(tool, {
        text: 't',
        slideIndex: 0,
        layoutName: 'Blank',
        format: { bold: true },
      });
      expect(preview.kind).toBe('summary');
    }
  });
});

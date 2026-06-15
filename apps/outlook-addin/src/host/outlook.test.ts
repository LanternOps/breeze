import { describe, expect, it } from 'vitest';
import { outlookHostAdapter } from './outlook';
import { buildOutlookPreview } from '../approval/buildPreview';
import { captureOutlookContext, captureOutlookSubject } from '../chat/captureContext';
import { OUTLOOK_MUTATING_TOOLS, OUTLOOK_TOOL_EXECUTORS } from '../tools/dispatcher';
import { captureOutlookSelectionLabel, subscribeOutlookItemChanged } from './outlookSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

describe('outlookHostAdapter', () => {
  it('satisfies the HostAdapter shape (all 7 members)', () => {
    const adapter: HostAdapter = outlookHostAdapter;
    expect(typeof adapter.captureContext).toBe('function');
    expect(typeof adapter.captureName).toBe('function');
    expect(typeof adapter.buildPreview).toBe('function');
    expect(typeof adapter.captureSelectionAddress).toBe('function');
    expect(typeof adapter.subscribeSelectionChanged).toBe('function');
    expect(adapter.toolExecutors).toBeTypeOf('object');
    expect(adapter.mutatingTools).toBeInstanceOf(Set);
  });

  it('wires the EXISTING Outlook modules (no rewrite)', () => {
    expect(outlookHostAdapter.captureContext).toBe(captureOutlookContext);
    expect(outlookHostAdapter.captureName).toBe(captureOutlookSubject);
    expect(outlookHostAdapter.buildPreview).toBe(buildOutlookPreview);
    expect(outlookHostAdapter.toolExecutors).toBe(OUTLOOK_TOOL_EXECUTORS);
    expect(outlookHostAdapter.mutatingTools).toBe(OUTLOOK_MUTATING_TOOLS);
    expect(outlookHostAdapter.captureSelectionAddress).toBe(captureOutlookSelectionLabel);
    expect(outlookHostAdapter.subscribeSelectionChanged).toBe(subscribeOutlookItemChanged);
  });

  it('exposes the Outlook tool layer with draft_reply as the only mutating tool', () => {
    for (const name of outlookHostAdapter.mutatingTools) {
      expect(outlookHostAdapter.toolExecutors[name]).toBeTypeOf('function');
    }
    expect(outlookHostAdapter.toolExecutors['summarize_thread']).toBeTypeOf('function');
    expect(outlookHostAdapter.mutatingTools.has('summarize_thread')).toBe(false);
    expect(outlookHostAdapter.mutatingTools.has('draft_reply')).toBe(true);
  });

  it('hides the context picker (mail has one context) and uses mail vocabulary', () => {
    expect(outlookHostAdapter.hideContextPicker).toBe(true);
    // No dropdown ⇒ no options to render.
    expect(outlookHostAdapter.contextOptions).toBeUndefined();
    expect(outlookHostAdapter.composerPlaceholder).toBe('Ask anything about this email…');
  });

  it('formatContextChip shows the subject verbatim and mail vocabulary', () => {
    const fmt = outlookHostAdapter.formatContextChip;
    expect(fmt).toBeTypeOf('function');
    if (!fmt) return;
    // A subject containing `!` must NOT be parsed as an Excel address.
    expect(fmt('selection', 'Re: Urgent! Read this')).toBe('Re: Urgent! Read this');
    expect(fmt('selection', undefined)).toBe('This email');
    expect(fmt('none', undefined)).toBe('(none)');
  });

  it('buildPreview returns a text card carrying the body for draft_reply', async () => {
    const preview = await outlookHostAdapter.buildPreview('draft_reply', { body: 'Hi there.' });
    expect(preview.kind).toBe('text');
    expect((preview as { after: string }).after).toBe('Hi there.');
  });
});

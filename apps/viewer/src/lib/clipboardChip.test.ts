import { describe, it, expect } from 'vitest';
import { clipboardChipView, clipboardFailureMessage, formatBytes, RECENT_TRANSFER_MS } from './clipboardChip';
import type { ClipboardSyncState } from './clipboardSync';

const NOW = 100_000;

function webrtc(state: Partial<ClipboardSyncState>) {
  return {
    kind: 'webrtc' as const,
    state: { open: true, status: null, lastTransfer: null, remoteItemAvailable: false, ...state },
  };
}

const STATUS = {
  hostToViewer: true, viewerToHost: true, chunked: true, suppressesBaseline: true,
  maxTextBytes: 1 << 20, maxImageBytes: 8 << 20,
};

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [2150, '2.1 KB'],
    [1024 * 1024, '1.0 MB'],
    [2.5 * 1024 * 1024, '2.5 MB'],
  ])('%i → %s', (n, s) => {
    expect(formatBytes(n)).toBe(s);
  });
});

describe('clipboardChipView', () => {
  it('is hidden when there is nothing to report', () => {
    expect(clipboardChipView({ kind: 'hidden' }, NOW).visible).toBe(false);
  });

  it('explains a transport with no clipboard', () => {
    const v = clipboardChipView({ kind: 'unavailable', reason: 'Clipboard is not available over the WebSocket fallback.' }, NOW);
    expect(v).toMatchObject({ visible: true, tone: 'off', canSend: false, canCopyRemote: false });
    expect(v.title).toContain('WebSocket fallback');
  });

  it('says so when an agent did not report status', () => {
    const v = clipboardChipView(webrtc({}), NOW);
    expect(v.tone).toBe('unknown');
    expect(v.title).toMatch(/did not report clipboard status/);
    expect(v.canSend).toBe(true);
  });

  it('shows both directions on', () => {
    const v = clipboardChipView(webrtc({ status: STATUS }), NOW);
    expect(v.tone).toBe('ok');
    expect(v.lines).toEqual(['Remote → local: On', 'Local → remote: On']);
  });

  it('shows a direction disabled by policy, and disables its action', () => {
    const v = clipboardChipView(webrtc({ status: { ...STATUS, viewerToHost: false }, remoteItemAvailable: true }), NOW);
    expect(v.tone).toBe('partial');
    expect(v.lines).toContain('Local → remote: Disabled by policy');
    expect(v.canSend).toBe(false);
    expect(v.canCopyRemote).toBe(true);
  });

  it('shows both directions disabled', () => {
    const v = clipboardChipView(webrtc({ status: { ...STATUS, hostToViewer: false, viewerToHost: false }, remoteItemAvailable: true }), NOW);
    expect(v.tone).toBe('off');
    expect(v.label).toBe('Clipboard off');
    expect(v.canCopyRemote).toBe(false);
    expect(v.canSend).toBe(false);
  });

  it('offers "Copy remote clipboard" only once a remote item is held', () => {
    expect(clipboardChipView(webrtc({ status: STATUS }), NOW).canCopyRemote).toBe(false);
    expect(clipboardChipView(webrtc({ status: STATUS, remoteItemAvailable: true }), NOW).canCopyRemote).toBe(true);
  });

  it('disables both actions on a closed channel', () => {
    const v = clipboardChipView(webrtc({ open: false, status: STATUS, remoteItemAvailable: true }), NOW);
    expect(v).toMatchObject({ canSend: false, canCopyRemote: false, tone: 'off' });
  });

  it('shows a recent transfer briefly, then keeps it in the tooltip', () => {
    const lastTransfer = { direction: 'from-remote' as const, type: 'text' as const, bytes: 2150, at: NOW - 100 };
    const fresh = clipboardChipView(webrtc({ status: STATUS, lastTransfer }), NOW);
    expect(fresh.recent).toBe('Copied 2.1 KB from remote');
    const old = clipboardChipView(webrtc({ status: STATUS, lastTransfer }), NOW + RECENT_TRANSFER_MS);
    expect(old.recent).toBeNull();
    expect(old.lines).toContain('Last: 2.1 KB text from remote');
  });

  it('words an outgoing transfer', () => {
    const lastTransfer = { direction: 'to-remote' as const, type: 'image' as const, bytes: 2 * 1024 * 1024, at: NOW };
    const v = clipboardChipView(webrtc({ status: STATUS, lastTransfer }), NOW);
    expect(v.recent).toBe('Sent 2.0 MB to remote');
    expect(v.lines).toContain('Last: 2.0 MB image to remote');
  });

  it('keeps VNC clipboard off when no policy was reported', () => {
    const v = clipboardChipView({ kind: 'vnc', policy: null, lastTransfer: null, remoteItemAvailable: true }, NOW);
    expect(v).toMatchObject({ tone: 'off', canSend: false, canCopyRemote: false, label: 'Clipboard off' });
    expect(v.title).toMatch(/did not report a clipboard policy/);
  });

  it('shows VNC as text only under its policy', () => {
    const v = clipboardChipView({
      kind: 'vnc', policy: { hostToViewer: true, viewerToHost: false }, lastTransfer: null, remoteItemAvailable: true,
    }, NOW);
    expect(v.tone).toBe('partial');
    expect(v.lines).toContain('Local → remote: Disabled by policy');
    expect(v.title).toMatch(/Text only/);
    expect(v.canCopyRemote).toBe(true);
    expect(v.canSend).toBe(false);
  });
});

describe('clipboardFailureMessage', () => {
  it('says nothing was pasted when a paste was cancelled', () => {
    for (const reason of ['too-large', 'send-failed', 'no-ack', 'closed', 'disabled'] as const) {
      expect(clipboardFailureMessage(reason, 'paste')).toMatch(/^Nothing pasted — /);
    }
  });

  it('explains each reason', () => {
    expect(clipboardFailureMessage('too-large', 'paste')).toMatch(/larger than the remote accepts/);
    expect(clipboardFailureMessage('no-ack', 'paste')).toMatch(/did not confirm/);
    expect(clipboardFailureMessage('closed', 'send')).toMatch(/^Clipboard not sent — .*connection closed/);
    expect(clipboardFailureMessage('disabled', 'send')).toMatch(/disabled by policy/);
  });
});

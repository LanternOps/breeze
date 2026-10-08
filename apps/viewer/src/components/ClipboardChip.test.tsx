import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClipboardChip } from './ClipboardChip';
import type { ClipboardChipInput } from '../lib/clipboardChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(input: ClipboardChipInput, handlers = { onCopyRemote: vi.fn(), onSendToRemote: vi.fn() }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ClipboardChip input={input} {...handlers} />));
  return { host, ...handlers };
}

const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const STATUS = {
  hostToViewer: true, viewerToHost: false, chunked: true, suppressesBaseline: true,
  maxTextBytes: 1 << 20, maxImageBytes: 8 << 20,
};

describe('ClipboardChip', () => {
  it('renders nothing when hidden', () => {
    render({ kind: 'hidden' });
    expect(q('clipboard-chip')).toBeNull();
  });

  it('shows the policy and wires the enabled action only', () => {
    const { onCopyRemote, onSendToRemote } = render({
      kind: 'webrtc',
      state: { open: true, status: STATUS, lastTransfer: null, remoteItemAvailable: true },
    });
    expect(q('clipboard-chip')!.title).toContain('Local → remote: Disabled by policy');
    act(() => q('clipboard-chip')!.click());
    expect(q('clipboard-send-remote')!.disabled).toBe(true);
    act(() => q('clipboard-copy-remote')!.click());
    expect(onCopyRemote).toHaveBeenCalledOnce();
    expect(onSendToRemote).not.toHaveBeenCalled();
  });

  it('shows a recent transfer on the chip itself', () => {
    render({
      kind: 'webrtc',
      state: {
        open: true, status: { ...STATUS, viewerToHost: true }, remoteItemAvailable: true,
        lastTransfer: { direction: 'from-remote', type: 'text', bytes: 2150, at: Date.now() },
      },
    });
    expect(q('clipboard-chip-label')!.textContent).toBe('Copied 2.1 KB from remote');
  });
});

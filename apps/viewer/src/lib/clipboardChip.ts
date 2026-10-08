/**
 * What the toolbar's clipboard chip says (spec gotcha C4): which directions
 * the agent's policy allows, whether the agent reported at all, and what last
 * crossed. Without it, "disabled by policy", "older agent" and "one direction
 * off" all look like a broken clipboard.
 */
import type { ClipboardSyncState, ClipboardTransfer } from './clipboardSync';

/** How long the chip shows "Copied 2.1 KB from remote" after a transfer. */
export const RECENT_TRANSFER_MS = 4_000;

export interface ClipboardDirectionPolicy {
  hostToViewer: boolean;
  viewerToHost: boolean;
}

export type ClipboardChipInput =
  | { kind: 'hidden' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'webrtc'; state: ClipboardSyncState }
  | {
      kind: 'vnc';
      /** null: no policy was reported for this session, so the clipboard stays off. */
      policy: ClipboardDirectionPolicy | null;
      lastTransfer: ClipboardTransfer | null;
      remoteItemAvailable: boolean;
    };

export interface ClipboardChipView {
  visible: boolean;
  tone: 'ok' | 'partial' | 'off' | 'unknown';
  label: string;
  /** Status lines for the chip's menu. */
  lines: string[];
  /** Tooltip: the lines plus any explanation. */
  title: string;
  /** A transfer in the last few seconds, worded for the chip itself. */
  recent: string | null;
  canCopyRemote: boolean;
  canSend: boolean;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const HIDDEN: ClipboardChipView = {
  visible: false, tone: 'off', label: '', lines: [], title: '', recent: null, canCopyRemote: false, canSend: false,
};

function directionLines(p: ClipboardDirectionPolicy): string[] {
  const word = (on: boolean) => (on ? 'On' : 'Disabled by policy');
  return [`Remote → local: ${word(p.hostToViewer)}`, `Local → remote: ${word(p.viewerToHost)}`];
}

function toneFor(p: ClipboardDirectionPolicy): ClipboardChipView['tone'] {
  if (p.hostToViewer && p.viewerToHost) return 'ok';
  if (p.hostToViewer || p.viewerToHost) return 'partial';
  return 'off';
}

function transferWords(t: ClipboardTransfer, now: number): { recent: string | null; line: string } {
  const size = formatBytes(t.bytes);
  const fromRemote = t.direction === 'from-remote';
  return {
    recent: now - t.at < RECENT_TRANSFER_MS ? (fromRemote ? `Copied ${size} from remote` : `Sent ${size} to remote`) : null,
    line: `Last: ${size} ${t.type} ${fromRemote ? 'from' : 'to'} remote`,
  };
}

function build(
  tone: ClipboardChipView['tone'],
  lines: string[],
  notes: string[],
  lastTransfer: ClipboardTransfer | null,
  now: number,
  actions: { canCopyRemote: boolean; canSend: boolean },
): ClipboardChipView {
  const t = lastTransfer ? transferWords(lastTransfer, now) : null;
  const allLines = t ? [...lines, t.line] : lines;
  return {
    visible: true,
    tone,
    label: tone === 'off' ? 'Clipboard off' : 'Clipboard',
    lines: allLines,
    title: [...notes, ...allLines].join('\n'),
    recent: t?.recent ?? null,
    ...actions,
  };
}

export function clipboardChipView(input: ClipboardChipInput, now: number): ClipboardChipView {
  switch (input.kind) {
    case 'hidden':
      return HIDDEN;
    case 'unavailable':
      return build('off', [], [input.reason], null, now, { canCopyRemote: false, canSend: false });
    case 'vnc': {
      if (!input.policy) {
        return build('off', [], [
          'Clipboard off on VNC: the server did not report a clipboard policy for this session.',
        ], input.lastTransfer, now, { canCopyRemote: false, canSend: false });
      }
      return build(toneFor(input.policy), directionLines(input.policy), ['Text only on VNC.'], input.lastTransfer, now, {
        canCopyRemote: input.policy.hostToViewer && input.remoteItemAvailable,
        canSend: input.policy.viewerToHost,
      });
    }
    case 'webrtc': {
      const { state } = input;
      if (!state.open) {
        return build('off', [], ['The clipboard channel is closed.'], state.lastTransfer, now, {
          canCopyRemote: false, canSend: false,
        });
      }
      if (!state.status) {
        return build('unknown', [], [
          'The agent did not report clipboard status (older agent): text only, policy unknown.',
        ], state.lastTransfer, now, { canCopyRemote: state.remoteItemAvailable, canSend: true });
      }
      return build(toneFor(state.status), directionLines(state.status), [], state.lastTransfer, now, {
        canCopyRemote: state.status.hostToViewer && state.remoteItemAvailable,
        canSend: state.status.viewerToHost,
      });
    }
  }
}

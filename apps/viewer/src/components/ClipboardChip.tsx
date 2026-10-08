import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Clipboard } from 'lucide-react';
import { clipboardChipView, RECENT_TRANSFER_MS, type ClipboardChipInput } from '../lib/clipboardChip';

const ClipboardIcon = Clipboard as unknown as ComponentType<{ className?: string }>;

const TONE_DOT: Record<string, string> = {
  ok: 'bg-green-400',
  partial: 'bg-yellow-400',
  off: 'bg-gray-500',
  unknown: 'bg-blue-400',
};

interface Props {
  input: ClipboardChipInput;
  onCopyRemote: () => void;
  onSendToRemote: () => void;
}

/**
 * Toolbar chip: per-direction clipboard state from the agent, the last
 * transfer, and the two explicit actions. "Copy remote clipboard" is how a
 * background window's skipped remote copy reaches the local clipboard; "Send
 * clipboard to remote" covers menu-driven paste on the remote (spec C1, C3).
 */
export function ClipboardChip({ input, onCopyRemote, onSendToRemote }: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  // Re-render when the inputs change and once more when "Copied …" expires.
  useEffect(() => {
    const at = Date.now();
    setNow(at);
    const last = input.kind === 'webrtc' ? input.state.lastTransfer : input.kind === 'vnc' ? input.lastTransfer : null;
    if (!last) return;
    const remaining = last.at + RECENT_TRANSFER_MS - at;
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 10);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const view = clipboardChipView(input, now);
  if (!view.visible) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="clipboard-chip"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded"
        title={view.title}
      >
        <ClipboardIcon className="w-3.5 h-3.5" />
        <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[view.tone]}`} aria-hidden="true" />
        <span data-testid="clipboard-chip-label">{view.recent ?? view.label}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
          <div className="px-3 py-1.5 text-xs text-gray-400 whitespace-pre-line" data-testid="clipboard-chip-status">
            {view.title}
          </div>
          <div className="border-t border-gray-700 my-1" />
          <button
            data-testid="clipboard-copy-remote"
            disabled={!view.canCopyRemote}
            onClick={() => { onCopyRemote(); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Copy remote clipboard
          </button>
          <button
            data-testid="clipboard-send-remote"
            disabled={!view.canSend}
            onClick={() => { onSendToRemote(); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send clipboard to remote
          </button>
        </div>
      )}
    </div>
  );
}

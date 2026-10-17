// Toolbar control for the per-session keyboard mode (W06, #8242). Shows the
// mode in force; "Physical keys" is disabled, with the reason, where the
// session cannot carry key codes. Not rendered where the mode does not apply
// (VNC, no transport yet).

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Keyboard, Check, ChevronDown } from 'lucide-react';
import type { KeyboardMode, KeyboardModeSupport } from '../lib/keyboardMode';

const KeyboardIcon = Keyboard as unknown as ComponentType<{ className?: string }>;
const CheckIcon = Check as unknown as ComponentType<{ className?: string }>;
const ChevronDownIcon = ChevronDown as unknown as ComponentType<{ className?: string }>;

const LABEL: Record<KeyboardMode, string> = {
  text: 'Type what I see',
  physical: 'Physical keys',
};

const DESCRIPTION: Record<KeyboardMode, string> = {
  text: 'Types the characters your keyboard shows, whatever the remote layout. Supports IME and accents.',
  physical: 'Sends physical keys; the remote keyboard layout decides the characters. For games, VMs and raw-key apps.',
};

interface Props {
  /** The mode in force (Physical already falls back where unsupported). */
  mode: KeyboardMode;
  support: KeyboardModeSupport;
  onChange: (mode: KeyboardMode) => void;
  disabled?: boolean;
}

export function KeyboardModeControl({ mode, support, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!support.applies) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="keyboard-mode"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? 'Unavailable in view-only mode' : `Keyboard mode: ${LABEL[mode]}`}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <KeyboardIcon className="w-3.5 h-3.5" />
        <span>{LABEL[mode]}</span>
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 w-72 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Keyboard mode</div>
          {(['text', 'physical'] as const).map((m) => {
            const unavailable = m === 'physical' && !support.physical;
            return (
              <button
                key={m}
                role="menuitemradio"
                aria-checked={mode === m}
                data-testid={`keyboard-mode-${m}`}
                disabled={unavailable}
                title={unavailable ? support.physicalUnavailableReason ?? undefined : DESCRIPTION[m]}
                onClick={() => {
                  setOpen(false);
                  if (!unavailable && m !== mode) onChange(m);
                }}
                className="w-full flex items-start justify-between gap-3 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="flex flex-col">
                  <span>{LABEL[m]}</span>
                  <span className="text-[10px] text-gray-500">
                    {unavailable ? support.physicalUnavailableReason : DESCRIPTION[m]}
                  </span>
                </span>
                {mode === m && <CheckIcon className="w-3 h-3 mt-0.5 text-accent-soft shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

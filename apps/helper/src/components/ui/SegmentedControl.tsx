import { useRef } from 'react';

interface Option { key: string; label: string }

/**
 * WAI-ARIA tabs pattern with automatic activation: a single roving tab stop
 * (the selected tab), Arrow keys move focus *and* selection, Home/End jump to
 * the ends, and navigation wraps.
 */
export function SegmentedControl({ options, value, onChange }: {
  options: Option[]; value: string; onChange: (key: string) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = options.findIndex((o) => o.key === value);
  // When `value` matches nothing keep the control reachable via the first tab.
  const tabStopIdx = selectedIdx >= 0 ? selectedIdx : 0;

  const goTo = (i: number) => {
    const next = options[i];
    if (!next) return;
    onChange(next.key);
    tabRefs.current[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (options.length === 0) return;
    // Navigate from the focused tab when the event came from one, else from
    // the selected tab.
    const focusedIdx = tabRefs.current.findIndex((el) => el === e.target);
    const from = focusedIdx >= 0 ? focusedIdx : tabStopIdx;
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); goTo(from >= last ? 0 : from + 1); break;
      case 'ArrowLeft': e.preventDefault(); goTo(from <= 0 ? last : from - 1); break;
      case 'Home': e.preventDefault(); goTo(0); break;
      case 'End': e.preventDefault(); goTo(last); break;
      default: break;
    }
  };

  return (
    <div role="tablist" className="ws-segmented" onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button key={o.key} role="tab" aria-selected={o.key === value}
          ref={(el) => { tabRefs.current[i] = el; }}
          tabIndex={i === tabStopIdx ? 0 : -1}
          className="ws-segmented-item" onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

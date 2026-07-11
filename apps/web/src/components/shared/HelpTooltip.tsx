import { HelpCircle } from 'lucide-react';
import { useState, useRef, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';

interface HelpTooltipProps {
  text: string;
  className?: string;
  /** Accessible name for the trigger — name the topic (e.g. "About the risk
   *  score") so icon-only triggers make sense to screen readers. */
  ariaLabel?: string;
  /** Which side the bubble opens on. Use 'bottom' when the trigger sits inside
   *  an overflow container (e.g. table headers inside the ResponsiveTable
   *  scroll wrapper): it positions the bubble `fixed` from the trigger's
   *  viewport rect, so the container can't clip it. Don't use 'bottom' inside
   *  transformed ancestors (drawers/dialogs), where fixed misplaces. */
  side?: 'top' | 'bottom';
}

export default function HelpTooltip({ text, className = '', ariaLabel, side = 'top' }: HelpTooltipProps) {
  const { t } = useTranslation('common');
  const [show, setShow] = useState(false);
  // Viewport coords for the side='bottom' fixed-position strategy, measured
  // from the trigger at open time (a hover tooltip closes before scroll
  // position can meaningfully drift).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  const open = () => {
    if (side === 'bottom' && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left + r.width / 2 });
    }
    setShow(true);
  };

  useEffect(() => {
    if (!show) return;
    const handleClick = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node) &&
          triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [show]);

  const bubbleBase =
    'w-56 rounded-md border bg-card px-3 py-2 text-left text-xs font-normal normal-case tracking-normal text-muted-foreground shadow-lg z-50';

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (show ? setShow(false) : open())}
        onMouseEnter={open}
        onMouseLeave={() => setShow(false)}
        onFocus={open}
        onBlur={() => setShow(false)}
        onKeyDown={(e) => {
          // Escape dismisses without moving focus — the tooltip never traps
          // or blocks keyboard flow.
          if (e.key === 'Escape') setShow(false);
        }}
        className="rounded-full p-0.5 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        aria-label={ariaLabel ?? t('shared.help')}
        aria-describedby={show ? tooltipId : undefined}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {show && side === 'top' && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 ${bubbleBase}`}
        >
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-border" />
        </div>
      )}
      {show && side === 'bottom' && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : undefined}
          className={`fixed -translate-x-1/2 ${bubbleBase}`}
        >
          {text}
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-border" />
        </div>
      )}
    </span>
  );
}

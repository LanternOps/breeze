import { HelpCircle } from 'lucide-react';
import { useState, useRef, useEffect, useLayoutEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface HelpTooltipProps {
  text: string;
  className?: string;
  /** Accessible name for the trigger — name the topic (e.g. "About the risk
   *  score") so icon-only triggers make sense to screen readers. */
  ariaLabel?: string;
  /** Preferred side. The bubble flips when there is more room on the other
   *  side and stays inside the viewport, including in scroll containers. */
  side?: 'top' | 'bottom';
}

export default function HelpTooltip({ text, className = '', ariaLabel, side = 'top' }: HelpTooltipProps) {
  const { t } = useTranslation('common');
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{
    top: number; left: number; arrowLeft: number; side: 'top' | 'bottom';
  } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  const open = () => {
    setShow(true);
  };

  useLayoutEffect(() => {
    if (!show) return;
    const updatePosition = () => {
      if (!triggerRef.current || !tooltipRef.current) return;
      const trigger = triggerRef.current.getBoundingClientRect();
      const bubble = tooltipRef.current.getBoundingClientRect();
      const margin = 8;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const center = trigger.left + trigger.width / 2;
      const left = Math.max(margin, Math.min(center - bubble.width / 2, viewportWidth - bubble.width - margin));
      const above = trigger.top - margin;
      const below = viewportHeight - trigger.bottom - margin;
      let actualSide = side;
      if (side === 'top' && above < bubble.height + margin && below > above) actualSide = 'bottom';
      if (side === 'bottom' && below < bubble.height + margin && above > below) actualSide = 'top';
      const desiredTop = actualSide === 'top' ? trigger.top - bubble.height - margin : trigger.bottom + margin;
      const top = Math.max(margin, Math.min(desiredTop, viewportHeight - bubble.height - margin));
      setPos({
        top, left, side: actualSide,
        arrowLeft: Math.max(8, Math.min(center - left, bubble.width - 8)),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [show, side, text]);

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
    'fixed w-56 max-w-[calc(100vw-1rem)] rounded-md border bg-card px-3 py-2 text-left text-xs font-normal normal-case tracking-normal text-muted-foreground shadow-lg z-50';

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
      {show && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className={bubbleBase}
        >
          <div className="max-h-[calc(100vh-3rem)] overflow-y-auto whitespace-normal [overflow-wrap:anywhere]">
            {text}
          </div>
          <div
            aria-hidden="true"
            style={{ left: pos?.arrowLeft }}
            className={`absolute -translate-x-1/2 border-4 border-transparent ${pos?.side === 'top' ? 'top-full border-t-border' : 'bottom-full border-b-border'}`}
          />
        </div>,
        document.body,
      )}
    </span>
  );
}

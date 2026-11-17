import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Gap between the sidebar's right edge and the flyout, and the viewport margin. */
const FLYOUT_GAP_PX = 6;

export interface RailSectionFlyoutProps {
  /** Section id: drives the `nav-section-rail-<id>` / `nav-section-flyout-<id>` test ids. */
  sectionId: string;
  /** Translated section label: the trigger's accessible name and the flyout heading. */
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** The current page lives in this section. */
  active: boolean;
  /** Renders the section's links with labels; called only while open. */
  renderLinks: () => ReactNode;
}

/**
 * A nav section in the collapsed icon rail. The rail has no room for section
 * labels or their links, so the section icon is a disclosure button that opens
 * the section as a labelled panel beside the sidebar.
 *
 * Disclosure, not `role="menu"`: the contents are ordinary navigation links, so
 * Tab moves through them and screen readers announce them as links. The panel
 * stays in the DOM right after its trigger (keyboard order follows the eye) and
 * escapes the nav's `overflow-y-auto` with `position: fixed` rather than a
 * portal — nothing between it and the viewport sets a transform or filter.
 *
 * Closes on Escape (focus returns to the trigger), an outside mousedown, focus
 * leaving the trigger and panel, a link click, and Astro navigation.
 */
export default function RailSectionFlyout({ sectionId, label, icon: Icon, active, renderLinks }: RailSectionFlyoutProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onNavigate = () => setOpen(false);
    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('astro:after-swap', onNavigate);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('astro:after-swap', onNavigate);
    };
  }, [open]);

  // Anchor beside the sidebar, top-aligned with the icon; slide up when the
  // section would run off the bottom of the viewport. Follows the rail's own
  // scroll and window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const railRight = trigger.closest('aside')?.getBoundingClientRect().right ?? rect.right;
      const panelHeight = panelRef.current?.offsetHeight ?? 0;
      const maxTop = window.innerHeight - FLYOUT_GAP_PX - panelHeight;
      setPanelStyle({
        position: 'fixed',
        top: Math.max(FLYOUT_GAP_PX, Math.min(rect.top - FLYOUT_GAP_PX, maxTop)),
        left: railRight + FLYOUT_GAP_PX,
        maxHeight: `calc(100vh - ${FLYOUT_GAP_PX * 2}px)`,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const focusFirstLink = () => {
    panelRef.current?.querySelector<HTMLAnchorElement>('a[href]')?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="flex justify-center"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        if (open && !rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid={`nav-section-rail-${sectionId}`}
        data-active={active || undefined}
        aria-label={label}
        title={open ? undefined : label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) setOpen(true);
            // The panel mounts on this render; focus once it exists.
            requestAnimationFrame(focusFirstLink);
          }
        }}
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-primary/10 text-primary hover:bg-primary/15'
            : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground',
          open && !active && 'bg-muted text-foreground',
        )}
      >
        <span aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          data-testid={`nav-section-flyout-${sectionId}`}
          role="group"
          aria-label={label}
          style={panelStyle}
          className="z-40 w-60 overflow-y-auto rounded-lg border bg-card p-2 shadow-lg"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a[href]')) setOpen(false);
          }}
        >
          <div className="px-2 pb-1.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="space-y-0.5">{renderLinks()}</div>
        </div>
      )}
    </div>
  );
}

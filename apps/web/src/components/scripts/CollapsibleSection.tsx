import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type CollapsibleSectionProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
};

export default function CollapsibleSection({
  title, open, onToggle, badge, summary, children,
}: CollapsibleSectionProps) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-base font-bold tracking-tight">{title}</h3>
          {badge}
          {!open && summary}
        </div>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        aria-hidden={!open}
        // The CSS collapse (grid-template-rows: 0fr + overflow-hidden below)
        // only hides the content visually — a focusable control inside it
        // stays reachable by Tab, which axe flags as aria-hidden-focus
        // (an aria-hidden ancestor containing a focusable descendant).
        // `inert` removes the subtree from both the accessibility tree and
        // the tab order, matching what aria-hidden alone only pretends to do.
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t px-4 pb-4 pt-3">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

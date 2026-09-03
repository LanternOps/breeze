import type { JSX, ReactNode } from 'react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  /** A lucide icon element. Defaults to an Inbox icon. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional content rendered between `description` and `action` — e.g. a
   *  short glossary or context block that must precede the CTA. */
  intro?: ReactNode;
  /** Primary CTA slot (e.g. a "Create" button). */
  action?: ReactNode;
  /** Secondary link/help slot, rendered below `action`. */
  secondary?: ReactNode;
  /** `sm` = compact, for inline table/panel empties. `md` = page-level. Defaults to `md`. */
  size?: 'sm' | 'md';
  /** data-testid passthrough on the outerframed card. */
  testId?: string;
  className?: string;
  /** Heading level for the title. Defaults to 3 (`<h3>`). */
  headingLevel?: 2 | 3 | 4;
}

const SIZE_CONTAINER_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'px-4 py-6',
  md: 'px-5 py-12',
};

const SIZE_ICON_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'h-5 w-5',
  md: 'h-7 w-7',
};

const SIZE_TITLE_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'mt-2 text-sm font-semibold',
  md: 'mt-3 text-base font-semibold',
};

const SIZE_DESCRIPTION_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'mt-1 text-xs text-muted-foreground',
  md: 'mt-1 text-sm text-muted-foreground',
};

/**
 * Reusable framed empty-state card, extracted from the pattern in
 * ApprovalsInbox (`approvals-empty`): dashed border, centred icon, heading,
 * description. `text-muted-foreground` / `border` are semantic tokens that
 * are already dark-mode aware via CSS custom properties (see
 * apps/web/src/styles/globals.css), so no explicit `dark:` classes are
 * needed here.
 */
export function EmptyState({
  icon,
  title,
  description,
  intro,
  action,
  secondary,
  size = 'md',
  testId,
  className,
  headingLevel = 3,
}: EmptyStateProps): JSX.Element {
  const Heading = (`h${headingLevel}` as const) as 'h2' | 'h3' | 'h4';
  const containerClassName = [
    // No `--border-strong` token exists (globals.css) — the plain `--border`
    // dark value (18% lightness) is near-invisible for a 1px dashed line, so
    // dark mode gets an explicit stronger override.
    'rounded-xl border border-dashed border-border dark:border-zinc-600 text-center',
    SIZE_CONTAINER_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClassName} data-testid={testId}>
      <div className="mx-auto flex w-fit items-center justify-center text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className={SIZE_ICON_CLASSES[size]} />}
      </div>
      <Heading className={SIZE_TITLE_CLASSES[size]}>{title}</Heading>
      {description && <p className={`mx-auto max-w-sm ${SIZE_DESCRIPTION_CLASSES[size]}`}>{description}</p>}
      {intro && <div className="mt-3">{intro}</div>}
      {action && (
        // The slot passes through whatever markup the caller renders, so a
        // caller shipping a padding-less button (e.g. a bare `<button>`
        // wired only with an onClick) still gets a usable minimum tap target
        // — this wrapper is the enforcement point, not the caller's choice.
        <div className="mt-4 flex justify-center [&>a,&>button]:min-h-10 [&>a,&>button]:py-2">{action}</div>
      )}
      {secondary && <div className="mt-2 flex justify-center text-sm">{secondary}</div>}
    </div>
  );
}

export default EmptyState;

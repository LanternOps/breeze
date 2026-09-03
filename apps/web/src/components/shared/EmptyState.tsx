import type { JSX, ReactNode } from 'react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  /** A lucide icon element. Defaults to an Inbox icon. */
  icon?: ReactNode;
  title: string;
  description?: string;
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
  action,
  secondary,
  size = 'md',
  testId,
  className,
  headingLevel = 3,
}: EmptyStateProps): JSX.Element {
  const Heading = (`h${headingLevel}` as const) as 'h2' | 'h3' | 'h4';
  const containerClassName = [
    'rounded-xl border border-dashed text-center',
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
      {action && <div className="mt-4 flex justify-center">{action}</div>}
      {secondary && <div className="mt-2 flex justify-center text-sm">{secondary}</div>}
    </div>
  );
}

export default EmptyState;

import type { JSX, ReactNode } from 'react';

export interface PageHeaderProps {
  /** A lucide icon element, rendered in a muted rounded tile beside the title. */
  icon?: ReactNode;
  title: string;
  /** Muted supporting copy under the title, clamped to a readable measure. */
  description?: string;
  /** Right-aligned action slot (buttons, a window switcher, etc.). Wraps onto
   *  its own line below `md` rather than crowding the title. */
  actions?: ReactNode;
  /** data-testid passthrough on the outer row. */
  testId?: string;
}

/**
 * Shared page-level header row: an optional icon tile, an `h1` title, an
 * optional description, and a right-aligned actions slot. Extracted from the
 * pattern duplicated across AI Agents pages (ImpactPage, RunsListPage) so the
 * title/description/actions layout — and its `md`-breakpoint wrap behavior —
 * lives in one place.
 */
export function PageHeader({ icon, title, description, actions, testId }: PageHeaderProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-muted-foreground">{description}</p>
          )}
        </div>
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div>
      )}
    </div>
  );
}

export default PageHeader;

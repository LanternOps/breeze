import type { JSX, ReactNode } from "react";

export interface IntegrationPanelHeaderProps {
  /** A lucide icon element, rendered in a muted tile beside the title. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Right-aligned action slot; wraps below the title under `md`. */
  actions?: ReactNode;
  testId?: string;
  headingTestId?: string;
}

/**
 * Heading row for a panel rendered inside the Integrations page. The page owns
 * the only `h1` (PageHeader), so a panel title is an `h2` one step below it —
 * never larger than the page title it sits under.
 */
export function IntegrationPanelHeader({
  icon,
  title,
  description,
  actions,
  testId,
  headingTestId,
}: IntegrationPanelHeaderProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight" data-testid={headingTestId}>
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div>
      )}
    </div>
  );
}

export default IntegrationPanelHeader;

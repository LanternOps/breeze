import { useId, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface FilterSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Accessible name for the select. Rendered visually hidden (`sr-only`) —
   *  the visible filter row still communicates purpose via layout/icons, but
   *  every filter control needs a real accessible name (axe `select-name`). */
  label: string;
  /** Test id forwarded to the underlying <select> for e2e selectors. */
  'data-testid'?: string;
}

/**
 * Shared wrapper for the list-page filter `<select>` pattern
 * (`h-10 rounded-md border … sm:w-36`/`sm:w-40`). Pairs the select with a
 * visually-hidden `<label htmlFor>` so screen readers announce a name instead
 * of "unlabelled combo box". See issue #7156.
 */
export function FilterSelect({ label, id, className, children, ...selectProps }: FilterSelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <>
      <label htmlFor={selectId} className="sr-only">
        {label}
      </label>
      <select
        id={selectId}
        className={cn(
          'h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
          className
        )}
        {...selectProps}
      >
        {children}
      </select>
    </>
  );
}

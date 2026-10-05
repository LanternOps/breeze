import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SummaryRow { label: string; value: ReactNode; figure?: boolean; testId?: string }

/** Label/value facts ("At a glance", the invoice a link controls): a hairline-ruled
 *  description list. Money takes the serif figures (DESIGN.md's two serif moments). */
export function SummaryList({ rows, className }: { rows: SummaryRow[]; className?: string }) {
  return (
    <dl className={cn('divide-y divide-border/70 border-y border-border/70', className)}>
      {rows.map(row => (
        <div key={row.label} className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2.5 min-[360px]:grid-cols-[minmax(6.5rem,38%)_1fr]" data-testid={row.testId}>
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground min-[360px]:pt-0.5">{row.label}</dt>
          <dd className={cn('break-words text-sm text-foreground', row.figure && 'font-display text-base font-semibold text-figures')}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default SummaryList;

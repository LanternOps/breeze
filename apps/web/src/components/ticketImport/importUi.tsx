import type { ReactNode } from 'react';
import type { useTranslation } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Small pieces the wizard's steps share (#8313 W6).
 */
export type TFunction = ReturnType<typeof useTranslation>['t'];

/**
 * runAction's `friendly`: the import and window refusals in this namespace's
 * own words (`ticketImport:errors.<CODE>`); anything else keeps the API's
 * message (or the shared `errors:` catalog runAction already consulted).
 */
export function importFriendly(t: TFunction) {
  return (code: string): string | undefined => {
    const key = `ticketImport:errors.${code}`;
    return i18n.exists(key) ? t(/* i18n-dynamic */ key) : undefined;
  };
}

export function Panel({ title, testId, children, actions, className }: {
  title?: ReactNode;
  testId: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border bg-card p-4', className)} data-testid={testId}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export const buttonPrimary = 'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
export const buttonSecondary = 'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50';
export const buttonDanger = 'inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50';
export const inputClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';
export const labelClass = 'block text-sm font-medium';

export function Notice({ tone = 'info', testId, children }: { tone?: 'info' | 'warning' | 'error' | 'success'; testId?: string; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'info' && 'border-border bg-muted/50',
        tone === 'warning' && 'border-warning/40 bg-warning/10',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'success' && 'border-success/40 bg-success/10',
      )}
    >
      {children}
    </div>
  );
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(i18n.language || undefined).format(value);
}

export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(i18n.language || undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(size)} ${units[unit]}`;
}

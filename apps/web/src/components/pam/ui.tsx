import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type ElevationFlowType,
  type ElevationStatus,
  FLOW_ICONS,
  FLOW_LABELS,
  STATUS_LABELS,
  statusBadgeClass,
} from './types';

/**
 * Shared presentational vocabulary for the /pam console. Class constants and
 * tiny components only — no data fetching, no state. Table/button/input chrome
 * mirrors the security pages (AntivirusPage, AdminAuditPage) so PAM reads as
 * part of the same product surface.
 */

export const tableWrapClass = 'overflow-x-auto rounded-lg border bg-card shadow-xs';
export const tableClass = 'min-w-full divide-y text-sm';
export const theadClass = 'bg-muted/40';
export const theadRowClass = 'text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';
export const thClass = 'px-4 py-3 font-semibold';
export const tbodyClass = 'divide-y';
export const rowClass = 'transition-colors hover:bg-muted/40';
export const tdClass = 'px-4 py-3';

export const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs';
/** Denser input for long forms (the rule modal) where vertical space is scarce. */
export const inputCompactClass = 'w-full rounded-md border bg-background px-3 py-1.5 text-sm shadow-xs';
export const selectClass = 'h-9 rounded-md border bg-background px-2.5 text-sm shadow-xs';

export const btnPrimaryClass =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50';
export const btnOutlineClass =
  'inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium shadow-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50';
export const btnOutlineDestructiveClass =
  'inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-card px-2.5 py-1.5 text-xs font-medium text-destructive shadow-xs transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50';
export const btnGhostClass =
  'inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

/** Inline error banner (role=alert), shared shape across every PAM surface. */
export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </div>
  );
}

/**
 * Skeleton placeholder for a loading table: header band plus shimmering rows.
 * `label` is announced to screen readers (reuses each tab's existing
 * "Loading …" copy) but not painted — skeletons carry the visual signal.
 */
export function TableSkeleton({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-live="polite" className={tableWrapClass}>
      <span className="sr-only">{label}</span>
      <div className="bg-muted/40 px-4 py-3">
        <div className="skeleton h-3 w-48" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3.5">
            <div className="skeleton h-3.5 w-32" />
            <div className="skeleton h-3.5 w-24" />
            <div className="skeleton h-3.5 min-w-0 flex-1" />
            <div className="skeleton h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dashed empty-state card: icon chip, title, supporting copy, optional extras. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="rounded-lg border border-dashed bg-card px-6 py-10 text-center"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

/** Rounded status pill; colors come from types.statusBadgeClass. */
export function StatusBadge({ status }: { status: ElevationStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Compact risk-tier chip for AI tool actions (tier ≥3 reads as destructive). */
export function RiskTierBadge({
  tier,
  testId,
  title,
}: {
  tier: number;
  testId: string;
  title: string;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      className={cn(
        'inline-flex shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold',
        tier >= 3
          ? 'bg-red-500/15 text-red-600 dark:text-red-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
      )}
    >
      T{tier}
    </span>
  );
}

/** Flow icon + label pair used by the Requests and Audit flow cells. */
export function FlowCell({ flowType }: { flowType: ElevationFlowType }) {
  const FlowIcon = FLOW_ICONS[flowType];
  return (
    <span className="inline-flex items-center gap-1.5">
      <FlowIcon aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      {FLOW_LABELS[flowType]}
    </span>
  );
}

/**
 * Prev/next pager. Labels arrive as props so each tab keeps its existing
 * translation keys.
 */
export function Pager({
  page,
  totalPages,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
  pageLabel,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  prevLabel: string;
  nextLabel: string;
  pageLabel: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <button type="button" disabled={page <= 1} onClick={onPrev} className={btnOutlineClass}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {prevLabel}
      </button>
      <span className="px-1 text-xs tabular-nums text-muted-foreground">{pageLabel}</span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={onNext}
        className={btnOutlineClass}
      >
        {nextLabel}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Toggle switch matching the app-wide pattern (PatchTab, backup primitives). */
export function Switch({
  checked,
  onToggle,
  testId,
  ariaLabel,
}: {
  checked: boolean;
  onToggle: () => void;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      onClick={onToggle}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition',
        checked ? 'bg-emerald-500/80' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 rounded-full bg-white transition',
          checked ? 'translate-x-5' : 'translate-x-1',
        )}
      />
    </button>
  );
}

/** Visible dialog header (h2 + optional subtitle) wired for aria-labelledby. */
export function DialogHeader({
  id,
  title,
  subtitle,
}: {
  id: string;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="border-b px-6 py-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

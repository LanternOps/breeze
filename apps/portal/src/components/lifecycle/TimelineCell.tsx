import React from 'react';
import { cn } from '@/lib/utils';
import { quarterLabel } from '@breeze/shared';
import type { HardwareLifecycleDeviceRow, ReplacementStatus } from '@breeze/shared';

/**
 * The timeline every row shares: one cell per quarter, from two years before
 * today to three years after. Ported from `drawHandCell`'s `RUNWAY_COL`
 * branch (packages/shared/src/reportPdf/hardwareLifecyclePdf.ts) — same
 * math, Tailwind opacity utilities instead of the PDF's colour mix. Each
 * cell carries a `title` with its quarter label (W03).
 */
export const TIMELINE_QUARTERS_BEFORE = 8;
export const TIMELINE_QUARTERS_AFTER = 12;
export const TIMELINE_QUARTERS = TIMELINE_QUARTERS_BEFORE + TIMELINE_QUARTERS_AFTER;

/** Whole quarters from `fromIso` to `toIso` (negative when `toIso` is earlier).
 *  Private to this component, matching the PDF file's own private helper. */
function quartersBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${toIso.slice(0, 10)}T00:00:00Z`);
  const qa = a.getUTCFullYear() * 4 + Math.floor(a.getUTCMonth() / 3);
  const qb = b.getUTCFullYear() * 4 + Math.floor(b.getUTCMonth() / 3);
  return qb - qa;
}

function yearsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / (365.25 * 86_400_000);
}

/** "3 months" under a year, half-years above it. */
function yearsLabel(years: number): string {
  if (years < 1) {
    const months = Math.max(1, Math.round(years * 12));
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const v = Math.round(years * 2) / 2;
  return `${v} yr`;
}

const TONE_SOLID: Record<ReplacementStatus, string> = {
  replace: 'bg-destructive',
  due_soon: 'bg-warning',
  supported: 'bg-success',
  unknown: 'bg-muted-foreground',
};
const TONE_TINT: Record<ReplacementStatus, string> = {
  replace: 'bg-destructive/25',
  due_soon: 'bg-warning/25',
  supported: 'bg-success/25',
  unknown: 'bg-muted-foreground/25',
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First-of-month ISO date `quarterOffset` quarters from `fromIso`, for
 *  feeding into `quarterLabel` (which only reads year + month from it). */
function isoAtQuarterOffset(fromIso: string, quarterOffset: number): string {
  const d = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const totalMonths = d.getUTCFullYear() * 12 + d.getUTCMonth() + quarterOffset * 3;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

export function TimelineCell({ row }: { row: HardwareLifecycleDeviceRow }) {
  // Status already reads "Purchase date unknown"; the timeline stays quiet.
  if (!row.replaceBy) return null;

  const today = todayIso();
  const todayQ = TIMELINE_QUARTERS_BEFORE;
  const dueQ = todayQ + quartersBetween(today, row.replaceBy);
  const boughtQ = row.purchaseDate
    ? todayQ + quartersBetween(today, row.purchaseDate)
    : Number.NEGATIVE_INFINITY;
  const tone = row.replacement;

  const years = yearsBetween(today, row.replaceBy);
  const overdue = row.replaceBy <= today;
  const label = overdue
    ? years < 1 / 24
      ? 'now'
      : `${yearsLabel(years)} over`
    : dueQ >= TIMELINE_QUARTERS
      ? `${yearsLabel(years)} out`
      : '';

  return (
    <div data-testid="lifecycle-timeline-cell" className="flex items-center gap-1.5">
      <div data-testid="lifecycle-timeline-grid" className="flex h-3.5 flex-1 gap-px">
        {Array.from({ length: TIMELINE_QUARTERS }, (_, q) => {
          const isDue = q === dueQ;
          const overdueRun = dueQ < todayQ && q > dueQ && q <= todayQ;
          const inLife = q >= boughtQ && q < dueQ;
          const fillClass = isDue || overdueRun ? TONE_SOLID[tone] : inLife ? TONE_TINT[tone] : 'bg-muted';
          const title = quarterLabel(isoAtQuarterOffset(today, q - todayQ));
          return (
            <div
              key={q}
              data-testid={`lifecycle-timeline-quarter-${q}`}
              title={title}
              className={cn(
                'h-full flex-1',
                fillClass,
                q === todayQ && 'border-x-2 border-foreground',
              )}
            />
          );
        })}
      </div>
      {label && (
        <span
          data-testid="lifecycle-timeline-label"
          className={cn('shrink-0 text-xs', overdue ? 'text-destructive-on-tint' : 'text-muted-foreground')}
        >
          {label}
        </span>
      )}
    </div>
  );
}

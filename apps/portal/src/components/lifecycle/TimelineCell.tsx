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
 *
 * Geometry matches the PDF, not the column: every quarter is a fixed 12px
 * square with a 2px gutter, so the grid is the same width on every row and
 * a quarter sits at the same x all the way down the table. A `flex-1` cell
 * stretched to whatever the column had left over, which on a normal laptop
 * read as a barcode of slivers. Today is one dark rule centred on the
 * current quarter that overshoots the cell by the row's own padding, so the
 * rules of adjacent rows meet and read as a single line through the plan.
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

/** The PDF's one-line key, for the plan table's foot: the grid's span and
 *  what the dark rule and the solid cell mean. */
export function timelineKeySentence(): string {
  const today = todayIso();
  const first = quarterLabel(isoAtQuarterOffset(today, -TIMELINE_QUARTERS_BEFORE));
  const last = quarterLabel(isoAtQuarterOffset(today, TIMELINE_QUARTERS_AFTER - 1));
  return `Replacement timeline: one square per quarter, ${first} to ${last}. The dark line is today; the solid square is the replace-by quarter.`;
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
    <div data-testid="lifecycle-timeline-cell" className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <div data-testid="lifecycle-timeline-grid" className="flex shrink-0 gap-0.5">
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
              className={cn('relative h-3 w-3 shrink-0 rounded-[2px]', fillClass)}
            >
              {q === todayQ && (
                <span
                  aria-hidden="true"
                  data-testid="lifecycle-timeline-today"
                  // At sm+ overshoots by the ledger row's vertical padding
                  // (CELL: sm:py-3.5) so consecutive rows' rules touch; on the
                  // phone card the cell has a label above it, so only a hair.
                  className="absolute -bottom-1 -top-1 left-1/2 w-0.5 -translate-x-1/2 bg-foreground sm:-bottom-3.5 sm:-top-3.5"
                />
              )}
            </div>
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

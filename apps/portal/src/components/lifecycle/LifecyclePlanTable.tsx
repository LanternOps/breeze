import React from 'react';
import { cn } from '@/lib/utils';
import {
  countByReplacement,
  monthYear,
  REPLACEMENT_LABELS,
  rowLabel,
  rowSecondary,
} from '@breeze/shared';
import type { HardwareLifecycleDeviceRow, ReplacementStatus } from '@breeze/shared';
import { withBase } from '@/lib/basePath';
import { CELL, ROW, TH } from '../portal/ui';
import { TimelineCell } from './TimelineCell';

/** Second line under the OS name so support risk is a word, not just a colour.
 *  Reproduced locally: the PDF's map (hardwareLifecyclePdf.ts) is a private
 *  const, not exported across the jsPDF boundary. */
const OS_RISK_TAG: Partial<Record<HardwareLifecycleDeviceRow['osSupport'], string>> = {
  ended: 'No security updates',
  ending: 'Support ending',
};

const STATUS_TONE_CLASS: Record<ReplacementStatus, string> = {
  replace: 'text-destructive-on-tint',
  due_soon: 'text-warning-on-tint',
  supported: 'text-success-on-tint',
  unknown: 'text-muted-foreground',
};

const STATUS_DOT_CLASS: Record<ReplacementStatus, string> = {
  replace: 'bg-destructive',
  due_soon: 'bg-warning',
  supported: 'bg-success',
  unknown: 'bg-muted-foreground/60',
};

const REPLACEMENT_ORDER: ReplacementStatus[] = ['replace', 'due_soon', 'supported', 'unknown'];

function ageCell(row: HardwareLifecycleDeviceRow): string {
  if (row.ageYears == null || row.ageYears <= 0) return '-';
  if (row.ageYears < 1) return '<1 yr';
  return `${Math.floor(row.ageYears)} yr`;
}

function purchasedCell(row: HardwareLifecycleDeviceRow): string {
  if (!row.purchaseDate) return '-';
  return `${monthYear(row.purchaseDate)}${row.purchaseDateSource === 'vendor' ? ' *' : ''}`;
}

export function LifecyclePlanTable({
  sectionId,
  title,
  ruleSentence,
  rows,
  // Defaults true (matching the schema's own `enable_self_service` default)
  // so an omitted prop keeps the pre-#5880 link behavior for any caller that
  // hasn't threaded the flag through yet.
  enableSelfService = true,
}: {
  sectionId: string;
  title: string;
  ruleSentence: string;
  rows: HardwareLifecycleDeviceRow[];
  enableSelfService?: boolean;
}) {
  const counts = countByReplacement(rows);
  const hasVendorSourcedDate = rows.some((r) => r.purchaseDateSource === 'vendor');

  return (
    <section data-testid={`lifecycle-plan-table-${sectionId}`} className="mt-8">
      <h3 className="font-display text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{ruleSentence}</p>

      <div
        data-testid={`lifecycle-plan-legend-${sectionId}`}
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
      >
        {REPLACEMENT_ORDER.filter((status) => (counts[status] ?? 0) > 0).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[status])} />
            {counts[status]} {REPLACEMENT_LABELS[status]}
          </span>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-sm sm:table">
          <thead className="hidden sm:table-header-group">
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>Computer</th>
              <th scope="col" className={cn(TH, 'text-left')}>Operating system</th>
              <th scope="col" className={cn(TH, 'text-right')}>Age</th>
              <th scope="col" className={cn(TH, 'text-left')}>Purchased</th>
              <th scope="col" className={cn(TH, 'text-left')}>Warranty</th>
              <th scope="col" className={cn(TH, 'text-left')}>Status</th>
              <th scope="col" className={cn(TH, 'text-left')}>Replacement timeline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70 sm:table-row-group">
            {rows.map((row) => {
              const label = rowLabel(row);
              const secondary = rowSecondary(row);
              const riskTag = OS_RISK_TAG[row.osSupport];
              const warrantyPast = Boolean(row.warrantyEndDate && row.warrantyEndDate < new Date().toISOString().slice(0, 10));
              return (
                <tr key={row.id} data-testid={`lifecycle-plan-row-${row.id}`} className={ROW}>
                  <td className={cn(CELL, 'font-semibold text-foreground')}>
                    {row.kind === 'device' && enableSelfService ? (
                      <a
                        href={withBase(`/devices#${row.id}`)}
                        data-testid={`lifecycle-plan-row-link-${row.id}`}
                        className="block font-semibold text-foreground underline-offset-4 hover:underline"
                      >
                        {label}
                      </a>
                    ) : (
                      <span className="block font-semibold text-foreground">{label}</span>
                    )}
                    {secondary && <span className="block text-xs text-muted-foreground">{secondary}</span>}
                  </td>
                  <td className={CELL}>
                    <span className="block">{row.os}</span>
                    {riskTag && (
                      <span
                        className={cn(
                          'block text-xs font-semibold',
                          row.osSupport === 'ended' ? 'text-destructive-on-tint' : 'text-warning-on-tint',
                        )}
                      >
                        {riskTag}
                      </span>
                    )}
                  </td>
                  <td className={cn(CELL, 'sm:text-right')}>{ageCell(row)}</td>
                  <td className={CELL}>{purchasedCell(row)}</td>
                  <td className={CELL}>
                    {!row.warrantyEndDate ? (
                      '-'
                    ) : warrantyPast ? (
                      <span className="text-muted-foreground">{`Expired ${monthYear(row.warrantyEndDate)}`}</span>
                    ) : (
                      monthYear(row.warrantyEndDate)
                    )}
                  </td>
                  <td className={CELL}>
                    <span className={cn('font-semibold', STATUS_TONE_CLASS[row.replacement])}>
                      {REPLACEMENT_LABELS[row.replacement]}
                    </span>
                  </td>
                  <td className={CELL}>
                    <TimelineCell row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasVendorSourcedDate && (
        <p data-testid={`lifecycle-plan-footnote-${sectionId}`} className="mt-2 text-xs text-muted-foreground">
          * Purchase date taken from the manufacturer&apos;s ship record.
        </p>
      )}
    </section>
  );
}

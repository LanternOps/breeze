import {
  buildAtAGlanceFacts,
  countByReplacement,
  REPLACEMENT_LABELS,
  type HardwareLifecycleDeviceRow,
  type ReplacementStatus,
} from '@breeze/shared';
import { StatusMark, type MarkTone } from '../portal/ui';

/**
 * The proportional bar at the top of the Hardware Lifecycle report: one
 * horizontal strip made of a segment per replacement band that actually has
 * devices in it, sized to the band's share of the fleet, with the fact
 * sentence underneath when there is something worth saying beyond the counts.
 */

const BAND_ORDER: ReplacementStatus[] = ['replace', 'due_soon', 'supported', 'unknown'];

const BAND_TONE: Record<ReplacementStatus, MarkTone> = {
  replace: 'destructive',
  due_soon: 'warning',
  supported: 'success',
  unknown: 'neutral',
};

const SEGMENT_BG: Record<ReplacementStatus, string> = {
  replace: 'bg-destructive/70',
  due_soon: 'bg-warning/70',
  supported: 'bg-success/70',
  unknown: 'bg-muted-foreground/30',
};

const GROW_CLASS: Record<number, string> = {
  1: 'grow-[1]',
  2: 'grow-[2]',
  3: 'grow-[3]',
  4: 'grow-[4]',
  5: 'grow-[5]',
  6: 'grow-[6]',
  7: 'grow-[7]',
  8: 'grow-[8]',
  9: 'grow-[9]',
  10: 'grow-[10]',
};

function growClassFor(count: number): string {
  return GROW_CLASS[count] ?? `grow-[${count}]`;
}

export function LifecycleStatusBar({ rows }: { rows: HardwareLifecycleDeviceRow[] }) {
  const counts = countByReplacement(rows);
  const bands = BAND_ORDER.filter((band) => counts[band] > 0);
  const fact = buildAtAGlanceFacts(rows);

  return (
    <div data-testid="lifecycle-status-bar">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {bands.map((band) => (
          <div
            key={band}
            data-testid={`lifecycle-status-segment-${band}`}
            className={`${growClassFor(counts[band])} ${SEGMENT_BG[band]}`}
          >
            <span className="sr-only">
              {counts[band]} {REPLACEMENT_LABELS[band]}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        {bands.map((band) => (
          <div key={band} data-testid={`lifecycle-status-figure-${band}`}>
            <div className="font-display text-2xl font-semibold text-foreground">{counts[band]}</div>
            <StatusMark tone={BAND_TONE[band]}>{REPLACEMENT_LABELS[band]}</StatusMark>
          </div>
        ))}
      </div>
      {fact !== '' && (
        <p data-testid="lifecycle-status-fact" className="mt-4 text-sm text-muted-foreground">
          {fact}
        </p>
      )}
    </div>
  );
}

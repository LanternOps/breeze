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

// Segment widths are literal, 5%-bucketed Tailwind arbitrary-value classes,
// never a runtime-interpolated class string: Tailwind's JIT compiler only
// picks up class names that appear as complete literal text in a scanned
// source file, so `` `w-[${percent}%]` `` (computed at render time) would
// compile to no CSS at all and silently collapse every segment on any fleet
// whose band split doesn't happen to match one of a small hardcoded set —
// exactly the "large fleet" scenario this page has to handle (spec section
// 5). This table's 21 entries are complete literal strings the compiler can
// find no matter how many devices a segment represents.
const WIDTH_CLASS_BY_5PCT: Record<number, string> = {
  0: 'w-[0%]', 5: 'w-[5%]', 10: 'w-[10%]', 15: 'w-[15%]', 20: 'w-[20%]',
  25: 'w-[25%]', 30: 'w-[30%]', 35: 'w-[35%]', 40: 'w-[40%]', 45: 'w-[45%]',
  50: 'w-[50%]', 55: 'w-[55%]', 60: 'w-[60%]', 65: 'w-[65%]', 70: 'w-[70%]',
  75: 'w-[75%]', 80: 'w-[80%]', 85: 'w-[85%]', 90: 'w-[90%]', 95: 'w-[95%]',
  100: 'w-[100%]',
};

/** Nearest-5% width class for a band's share of `total`, floored at 5% so a
 *  non-zero band never renders as an invisible sliver. */
function widthClassFor(count: number, total: number): string {
  if (total <= 0 || count <= 0) return WIDTH_CLASS_BY_5PCT[0]!;
  const percent = (count / total) * 100;
  const bucket = Math.min(100, Math.max(5, Math.round(percent / 5) * 5));
  return WIDTH_CLASS_BY_5PCT[bucket] ?? WIDTH_CLASS_BY_5PCT[100]!;
}

export function LifecycleStatusBar({ rows }: { rows: HardwareLifecycleDeviceRow[] }) {
  const counts = countByReplacement(rows);
  const bands = BAND_ORDER.filter((band) => counts[band] > 0);
  const total = rows.length;
  const fact = buildAtAGlanceFacts(rows);

  return (
    <div data-testid="lifecycle-status-bar">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {bands.map((band) => (
          <div
            key={band}
            data-testid={`lifecycle-status-segment-${band}`}
            className={`flex-none ${widthClassFor(counts[band], total)} ${SEGMENT_BG[band]}`}
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

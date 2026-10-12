import type { PortalHourBlockDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { money, portalLocale } from '@/lib/money';

/** SSR-safe: the same locale source as money(). */
function hours(value: number): string {
  return new Intl.NumberFormat(portalLocale(), { maximumFractionDigits: 2 }).format(value);
}

function hoursLabel(value: number): string {
  return `${hours(value)} ${value === 1 ? 'hour' : 'hours'}`;
}

/** The API's end is half-open (the first day of the NEXT period); a customer
 *  reads "through" dates, so show the inclusive last day. */
function periodLabel(start: string, endExclusive: string): string {
  const fmt = new Intl.DateTimeFormat(portalLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const last = new Date(`${endExclusive}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return `${fmt.format(new Date(`${start}T00:00:00Z`))} – ${fmt.format(last)}`;
}

export function HourBlockCard({ hourBlock }: { hourBlock: PortalHourBlockDto }) {
  const total = hourBlock.includedHours + hourBlock.carriedInHours;
  const percent = total > 0 ? Math.min(100, Math.round((hourBlock.usedHours / total) * 100)) : 100;
  const over = hourBlock.overageHours > 0;

  return (
    <section
      className="mb-8 border-y border-border/70 px-4 py-5"
      data-testid="portal-hour-block"
      aria-label="Support hours"
    >
      <h2 className="font-display text-lg font-semibold text-foreground">Support hours</h2>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="portal-hour-block-period">
        Period: {periodLabel(hourBlock.periodStart, hourBlock.periodEnd)}
      </p>

      <p className="text-figures mt-4 text-base font-medium text-foreground" data-testid="portal-hour-block-used">
        {`${hours(hourBlock.usedHours)} of ${hoursLabel(total)} used`}
      </p>

      <div
        role="progressbar"
        aria-label="Support hours used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-border/70"
      >
        <div
          className={cn('h-full rounded-full', over ? 'bg-destructive' : 'bg-foreground/70')}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p
        className={cn('text-figures mt-2 text-sm', over ? 'text-destructive-on-tint' : 'text-muted-foreground')}
        data-testid="portal-hour-block-remaining"
      >
        {over
          ? `${hoursLabel(hourBlock.overageHours)} over your block`
          : `${hoursLabel(hourBlock.remainingHours)} remaining`}
      </p>

      {hourBlock.carriedInHours > 0 && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="portal-hour-block-carried">
          {`Includes ${hoursLabel(hourBlock.carriedInHours)} carried over from last period`}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground" data-testid="portal-hour-block-rate">
        {`Hours beyond your block are billed at ${money(hourBlock.overageRate, hourBlock.currencyCode)} per hour ${
          hourBlock.billingTiming === 'arrears'
            ? "on this period's invoice."
            : 'on the invoice for the following period.'
        }`}
      </p>
    </section>
  );
}

/** A block that exists but whose first period has not started (added mid-period). */
export function HourBlockStartsNotice({ startsOn }: { startsOn: string }) {
  const fmt = new Intl.DateTimeFormat(portalLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return (
    <section
      className="mb-8 border-y border-border/70 px-4 py-5"
      data-testid="portal-hour-block-starts"
      aria-label="Support hours"
    >
      <h2 className="font-display text-lg font-semibold text-foreground">Support hours</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {`Your support hours start ${fmt.format(new Date(`${startsOn}T00:00:00Z`))}.`}
      </p>
    </section>
  );
}

export default HourBlockCard;

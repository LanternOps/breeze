import type { InvoiceSummary } from '@/lib/api';
import { money } from '@/lib/format';

/**
 * Twelve ruled months of what the firm has billed, above the invoice ledger.
 * One quiet figure: "what do I spend with these people" — a question the
 * ledger's rows answer only by adding them up. Bars are the portal's one
 * working ink; the window's total sits beside them in words. Drawn only when
 * there is something to draw and every invoice shares one currency (a mixed
 * sum is a made-up number — same rule as the ledger foot).
 */
export interface BilledMonth {
  key: string;
  label: string;
  total: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Drafts were never sent; a void was withdrawn. Neither is a bill. */
const NOT_BILLED = new Set<InvoiceSummary['status']>(['draft', 'void']);

export function billedByMonth(invoices: InvoiceSummary[], now: Date = new Date()): BilledMonth[] {
  const months: BilledMonth[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let i = 11; i >= 0; i -= 1) {
    const total = year * 12 + month - i;
    const y = Math.floor(total / 12);
    const m = total - y * 12;
    months.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label: MONTHS[m], total: 0 });
  }
  const byKey = new Map(months.map((row) => [row.key, row]));
  for (const inv of invoices) {
    if (!inv.issueDate || NOT_BILLED.has(inv.status)) continue;
    const row = byKey.get(inv.issueDate.slice(0, 7));
    const amount = Number(inv.total);
    if (row && Number.isFinite(amount)) row.total += amount;
  }
  return months;
}

const BAR_W = 22;
const GAP = 8;
const H = 48;
const WIDTH = 12 * BAR_W + 11 * GAP;

export function BilledByMonth({ invoices }: { invoices: InvoiceSummary[] }) {
  const currencies = new Set(invoices.map((i) => i.currencyCode));
  if (currencies.size !== 1) return null;
  const currency = invoices[0].currencyCode;
  const months = billedByMonth(invoices);
  const sum = months.reduce((s, m) => s + m.total, 0);
  if (sum <= 0) return null;
  const max = Math.max(...months.map((m) => m.total));
  const first = months[0];
  const last = months[months.length - 1];

  return (
    <section
      data-testid="portal-billed-by-month"
      className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-y border-border/70 py-4"
    >
      <div className="w-full max-w-[22rem]">
        {/* No width attribute: the figure scales with the sheet on a phone
            and stops at its drawn size on a desktop. */}
        <svg
          viewBox={`0 0 ${WIDTH} ${H}`}
          role="img"
          aria-label={`Billed by month, ${first.label} to ${last.label}`}
          className="block h-auto w-full text-primary"
        >
          {months.map((m, i) => {
            // Ink-height with a 4px floor so a small month still registers;
            // an empty month draws a hairline foot so the axis stays legible.
            const h = m.total > 0 ? Math.max(4, Math.round((m.total / max) * H)) : 1;
            return (
              <rect
                key={m.key}
                data-testid={`portal-billed-bar-${m.key}`}
                x={i * (BAR_W + GAP)}
                y={H - h}
                width={BAR_W}
                height={h}
                rx={m.total > 0 ? 2 : 0}
                fill="currentColor"
                fillOpacity={m.total > 0 ? 1 : 0.35}
              >
                <title>{`${m.label} ${m.key.slice(0, 4)}: ${money(m.total, currency)}`}</title>
              </rect>
            );
          })}
        </svg>
        <div
          className="mt-1.5 flex justify-between text-xs text-muted-foreground"
          aria-hidden="true"
        >
          <span>{first.label}</span>
          <span>{last.label}</span>
        </div>
      </div>
      <p data-testid="portal-billed-total" className="text-sm text-muted-foreground">
        <span className="text-figures font-display text-lg font-semibold text-foreground">{money(sum, currency)}</span>
        {' '}billed in the last 12 months
      </p>
    </section>
  );
}

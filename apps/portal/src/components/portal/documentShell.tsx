// Shared "paper" presentation for customer-facing documents (proposals +
// invoices). Gives the portal quote/invoice views one premium, branded look:
// an accent top rule, a logo/seller header, and a totals/terms rhythm. The
// accent comes from the partner's brand color (portal branding.primaryColor)
// with the app primary as the fallback. Mirrors the dashboard's QuoteDocument so
// staff preview and customer view match.
import type { CSSProperties, ReactNode } from 'react';
import { sellerLines } from '@/lib/sellerLines';

export interface DocSeller {
  name: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

function accentVars(primaryColor?: string | null): CSSProperties {
  return { ['--doc-accent']: primaryColor || 'hsl(var(--primary))' } as CSSProperties;
}

/** The bordered document card with a partner-accent top rule. */
export function DocumentPaper({
  primaryColor, children, testId,
}: { primaryColor?: string | null; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      style={accentVars(primaryColor)}
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="h-1.5 w-full" style={{ backgroundColor: 'var(--doc-accent)' }} aria-hidden />
      <div className="space-y-10 px-4 py-7 sm:px-10 sm:py-9">{children}</div>
    </div>
  );
}

/** Header band: logo/wordmark + seller "From" on the left; eyebrow + title +
 *  status + dates on the right; optional "Prepared for / Bill to" line below. */
export function DocumentHeader({
  logoUrl, partnerName, seller, eyebrow, title, statusLabel, statusClass, dates,
  preparedForLabel = 'Prepared for', preparedForName,
}: {
  logoUrl?: string | null;
  partnerName?: string | null;
  seller: DocSeller | null;
  eyebrow: string;
  title: string;
  statusLabel?: string;
  statusClass?: string;
  dates: { label: string; value: string }[];
  preparedForLabel?: string;
  preparedForName?: string | null;
}) {
  const showSeller = seller && (seller.name || seller.email || seller.phone || seller.website || sellerLines(seller.address).length > 0);
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          {logoUrl ? (
            <img src={logoUrl} alt={partnerName ?? ''} className="h-11 w-auto max-w-[220px] object-contain" />
          ) : partnerName ? (
            <p className="text-xl font-semibold tracking-tight text-foreground">{partnerName}</p>
          ) : null}
          {showSeller && (
            <address className="space-y-0.5 text-xs not-italic leading-relaxed text-muted-foreground">
              {seller!.name && <p className="font-medium text-foreground/80">{seller!.name}</p>}
              {sellerLines(seller!.address).map((l, i) => <p key={i}>{l}</p>)}
              {seller!.phone && <p>{seller!.phone}</p>}
              {seller!.email && <p>{seller!.email}</p>}
              {seller!.website && <p>{seller!.website}</p>}
            </address>
          )}
        </div>

        <div className="space-y-2 sm:text-right">
          <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--doc-accent)' }}>{eyebrow}</p>
          <p className="text-2xl font-semibold tracking-tight text-foreground">{title}</p>
          {statusLabel && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusClass ?? 'bg-muted text-muted-foreground'}`}>
              {statusLabel}
            </span>
          )}
          <dl className="space-y-0.5 pt-1 text-xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
            {dates.map((d, i) => (
              <div key={i} className="flex gap-2"><dt>{d.label}</dt><dd className="font-medium text-foreground/80">{d.value}</dd></div>
            ))}
          </dl>
        </div>
      </header>

      {preparedForName && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{preparedForLabel}</p>
          <p className="mt-1 text-base font-medium text-foreground">{preparedForName}</p>
        </div>
      )}
    </div>
  );
}

/** A bordered terms/notes block under a horizontal rule. */
export function DocumentTerms({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2 border-t pt-6" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      <p className="max-w-prose whitespace-pre-wrap text-pretty text-xs leading-relaxed text-muted-foreground">{children}</p>
    </section>
  );
}

/** Centered footer line (partner footer text). */
export function DocumentFooter({ children }: { children: ReactNode }) {
  return <footer className="border-t pt-6 text-center text-xs leading-relaxed text-muted-foreground">{children}</footer>;
}

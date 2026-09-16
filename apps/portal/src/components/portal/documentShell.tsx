// Shared "paper" presentation for customer-facing documents (proposals +
// invoices). Gives the portal quote/invoice views one premium, branded look:
// an accent top rule, a logo/seller header, and a totals/terms rhythm. The
// accent comes from the partner's brand color (portal branding.primaryColor)
// with the app primary as the fallback. Mirrors the dashboard's QuoteDocument so
// staff preview and customer view match.
import { markChipClass, type MarkTone } from './ui';
import type { ReactNode } from 'react';
import { sellerLines } from '@/lib/sellerLines';
import type { DocumentThemeId } from '@breeze/shared';

export interface DocSeller {
  name: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

/** The bordered document card with a partner-accent top rule.
 *
 *  `primaryColor` is accepted but not applied here: the accent reaches the page
 *  as `--doc-accent` through the layout's nonced <style> element (lib/docAccent.ts
 *  explains why a style attribute cannot carry it) and is consumed by the
 *  `.doc-accent-*` classes. The prop stays so the value documents intent at the
 *  call site. */
export function DocumentPaper({
  children, testId, docTheme,
}: { primaryColor?: string | null; children: ReactNode; testId?: string; docTheme?: DocumentThemeId | null }) {
  return (
    <div
      data-testid={testId}
      data-doc-theme={docTheme ?? 'classic'}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="doc-accent-bg h-1.5 w-full" aria-hidden />
      <div className="space-y-10 px-4 py-7 sm:px-10 sm:py-9">{children}</div>
    </div>
  );
}

/** Header band: logo/wordmark + seller "From" on the left; eyebrow + title +
 *  status + dates on the right; optional "Prepared for / Bill to" line below. */
/**
 * The proposal's cover, on screen. The spec calls it a page frame rendered as
 * the proposal's first page; the PDF has always drawn it, but the customer's
 * on-screen document skipped straight to the number-and-dates header, so a
 * titled, branded cover the MSP authored was invisible until download. It
 * carries the cover title as the page's H1 (the header's number steps down to
 * an h2), the cover image when one is set, and prepared for / prepared by.
 */
export function DocumentCover({
  title, imageUrl, preparedForName, preparedByName, showPreparedBy, eyebrow = 'Proposal',
}: {
  title: string;
  imageUrl?: string | null;
  preparedForName?: string | null;
  preparedByName?: string | null;
  showPreparedBy: boolean;
  eyebrow?: string;
}) {
  return (
    <section data-testid="doc-cover" className="-mx-4 -mt-7 border-b sm:-mx-10 sm:-mt-9">
      {imageUrl && (
        <img src={imageUrl} alt="" className="h-48 w-full object-cover sm:h-64" data-testid="doc-cover-image" />
      )}
      <div className="space-y-6 px-4 py-8 sm:px-10 sm:py-12">
        <div className="space-y-3">
          <p className="doc-accent-text text-xs font-semibold uppercase tracking-[0.18em]">{eyebrow}</p>
          <h1 className="max-w-[24ch] font-display text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl">
            {title}
          </h1>
        </div>
        {(preparedForName || (showPreparedBy && preparedByName)) && (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            {preparedForName && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prepared for</dt>
                <dd className="mt-1 font-medium text-foreground">{preparedForName}</dd>
              </div>
            )}
            {showPreparedBy && preparedByName && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prepared by</dt>
                <dd className="mt-1 font-medium text-foreground">{preparedByName}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

export function DocumentHeader({
  logoUrl, partnerName, seller, eyebrow, title, subtitle, statusLabel, statusTone, dates,
  preparedForLabel = 'Prepared for', preparedForName, titleAs: TitleTag = 'h1',
}: {
  logoUrl?: string | null;
  partnerName?: string | null;
  seller: DocSeller | null;
  eyebrow: string;
  title: string;
  /** The document's human name (a proposal's title) under the number. */
  subtitle?: string | null;
  statusLabel?: string;
  statusTone?: MarkTone;
  dates: { label: string; value: string }[];
  preparedForLabel?: string;
  preparedForName?: string | null;
  /** h2 when a DocumentCover above already carries the page's H1. */
  titleAs?: 'h1' | 'h2';
}) {
  const showSeller = seller && (seller.name || seller.email || seller.phone || seller.website || sellerLines(seller.address).length > 0);
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          {logoUrl ? (
            <img src={logoUrl} alt={partnerName || 'Company logo'} className="h-11 w-auto max-w-[220px] object-contain" />
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
          <p className="doc-accent-text text-xs font-semibold uppercase tracking-[0.18em]">{eyebrow}</p>
          {/* The document number is the page's primary heading. It was a <p>,
              which left every proposal and invoice with no <h1> of its own. */}
          <TitleTag className="font-display text-2xl font-semibold tracking-tight text-foreground">{title}</TitleTag>
          {subtitle && <p className="text-sm font-medium text-foreground/80">{subtitle}</p>}
          {statusLabel && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${markChipClass(statusTone ?? 'neutral')}`}>
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

import type { ReactElement } from 'react';
import type { DocumentBranding, DocumentHeaderModel } from '@breeze/shared/documents';
import type { DocumentHostComponents } from './hostComponents';

type Tone = NonNullable<DocumentHeaderModel['status']>['tone'];

/** Tinted-chip classes per tone; the paper-scoped tokens in document.css make these AA-safe. */
const CHIP: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-primary/10 text-primary-on-tint',
  success: 'bg-success/10 text-success-on-tint',
  warning: 'bg-warning/10 text-warning-on-tint',
  danger: 'bg-destructive/10 text-destructive-on-tint',
};

const LOGO = 'h-11 w-auto max-w-[220px] object-contain';

/** Header band: logo/wordmark + seller on the left; eyebrow + number + status +
 *  dates on the right; bill-to below. */
export function DocumentHeader({
  header, branding, components, titleAs: TitleTag = 'h1',
}: {
  header: DocumentHeaderModel;
  branding: DocumentBranding;
  components: DocumentHostComponents;
  /** h2 when a cover above already carries the page's H1. */
  titleAs?: 'h1' | 'h2';
}): ReactElement {
  const { seller, logo, wordmark, logoAlt } = branding;
  const showSeller = seller && (seller.name || seller.lines.length > 0 || seller.phone || seller.email || seller.website);
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          {logo?.kind === 'asset' ? (
            <components.Image asset={logo.ref} alt={logoAlt} className={LOGO} />
          ) : logo?.kind === 'url' ? (
            <img src={logo.url} alt={logoAlt} className={LOGO} />
          ) : wordmark ? (
            <p className="text-xl font-semibold tracking-tight text-foreground">{wordmark}</p>
          ) : null}
          {showSeller && (
            <address className="space-y-0.5 text-xs not-italic leading-relaxed text-muted-foreground">
              {seller.name && <p className="font-medium text-foreground/80">{seller.name}</p>}
              {seller.lines.map((l, i) => <p key={i}>{l}</p>)}
              {seller.phone && <p>{seller.phone}</p>}
              {seller.email && <p>{seller.email}</p>}
              {seller.website && <p>{seller.website}</p>}
            </address>
          )}
        </div>

        <div className="space-y-2 sm:text-right">
          <p className="doc-accent-text text-xs font-semibold uppercase tracking-[0.18em]">{header.eyebrow}</p>
          <TitleTag className="doc-font-display text-2xl font-semibold tracking-tight text-foreground">{header.number}</TitleTag>
          {header.subtitle && <p className="text-sm font-medium text-foreground/80">{header.subtitle}</p>}
          {header.status && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${CHIP[header.status.tone]}`}>
              {header.status.label}
            </span>
          )}
          <dl className="space-y-0.5 pt-1 text-xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
            {header.dates.map((d, i) => (
              <div key={i} className="flex gap-2">
                <dt>{d.label}</dt>
                <dd className="font-medium text-foreground/80"><time dateTime={d.value.iso}>{d.value.text}</time></dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {header.billTo && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{header.billTo.label}</p>
          <p className="mt-1 text-base font-medium text-foreground">{header.billTo.name}</p>
          {(header.billTo.addressLines.length > 0 || header.billTo.taxId) && (
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-muted-foreground">
              {header.billTo.addressLines.map((l, i) => <p key={i}>{l}</p>)}
              {header.billTo.taxId && <p>{header.billTo.taxId}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

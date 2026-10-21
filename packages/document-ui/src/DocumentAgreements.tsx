import { ChevronDown, FileText } from 'lucide-react';
import type { ReactElement } from 'react';
import type { AgreementBody, QuoteAgreementModel, QuoteDocumentModel } from '@breeze/shared/documents';
import { TermsBody, useDeepLinkedDisclosure } from './DocumentTerms';
import type { DocumentHostComponents } from './hostComponents';

const UNAVAILABLE = 'rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground';

function Footer({ text }: { text: string }): ReactElement {
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

function Body({ body, title, components }: { body: AgreementBody; title: string; components: DocumentHostComponents }): ReactElement {
  if (body.kind === 'terms') return <TermsBody text={body.text} label={title} />;
  if (body.kind === 'authored') {
    return (
      <div className="space-y-3">
        {body.html ? (
          // Server-substituted HTML from an authored contract template: the same sanitizer
          // output as a rich_text block (`SanitizedHtml`), safe to render as-is.
          <div className="quote-rich-text max-w-prose text-sm leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: body.html }} />
        ) : (
          <div className={UNAVAILABLE}>{body.unavailableText}</div>
        )}
        <Footer text={body.footer} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {body.file ? (
        <components.AgreementFile asset={body.file} title={body.fileTitle} downloadLabel={body.downloadLabel} unavailableText={body.unavailableText} />
      ) : (
        <div className={UNAVAILABLE}>{body.unavailableText}</div>
      )}
      <Footer text={body.footer} />
    </div>
  );
}

function AgreementRow({
  agreement, labels, components,
}: {
  agreement: QuoteAgreementModel;
  labels: QuoteDocumentModel['agreementLabels'];
  components: DocumentHostComponents;
}): ReactElement {
  const [open, setOpen] = useDeepLinkedDisclosure(agreement.anchor);
  // An uploaded agreement's viewer fetches the whole file on mount and most readers never
  // open it, so its body mounts only while the row is open.
  const lazy = agreement.body.kind === 'uploaded';
  return (
    <details
      id={agreement.anchor}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group scroll-mt-4"
      data-testid={agreement.body.kind === 'terms' ? 'document-agreement-terms' : 'contract-block'}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{agreement.title}</span>
          <span className="block text-xs text-muted-foreground">{agreement.meta}</span>
        </span>
        {/* Visual affordance only — <details> already exposes expanded state. */}
        <span aria-hidden className="doc-accent-text shrink-0 text-xs font-medium">
          <span className="group-open:hidden">{labels.read}</span>
          <span className="hidden group-open:inline">{labels.hide}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t px-4 py-4 sm:px-5">
        {lazy && !open ? null : <Body body={agreement.body} title={agreement.title} components={components} />}
      </div>
    </details>
  );
}

/**
 * A quote's agreements (its contract blocks, then Terms & Conditions) as one list of
 * collapsed rows, placed after the price and the sign panel so long legal text never
 * pushes the totals down (#7040). Each row deep-links by anchor and expands for print.
 */
export function DocumentAgreements({
  agreements, labels, components,
}: {
  agreements: QuoteAgreementModel[];
  labels: QuoteDocumentModel['agreementLabels'];
  components: DocumentHostComponents;
}): ReactElement | null {
  if (agreements.length === 0) return null;
  return (
    <section className="space-y-3 border-t pt-6" data-testid="document-agreements">
      {/* A lone row's title already says what it is; a heading only earns its place once there is a list to name. */}
      {agreements.length > 1 && <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.heading}</h3>}
      <div className="divide-y overflow-hidden rounded-lg border">
        {agreements.map((agreement) => (
          <AgreementRow key={agreement.id} agreement={agreement} labels={labels} components={components} />
        ))}
      </div>
    </section>
  );
}

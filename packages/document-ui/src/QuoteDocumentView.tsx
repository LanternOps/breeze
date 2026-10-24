import type { ReactElement } from 'react';
import type { QuoteDocumentModel } from '@breeze/shared/documents';
import { DocumentPaper } from './DocumentPaper';
import { DocumentHeader } from './DocumentHeader';
import { DocumentCover } from './DocumentCover';
import { QuoteBlocks } from './QuoteBlocks';
import { DocumentTotals } from './DocumentTotals';
import { DocumentNotes } from './DocumentNotes';
import { DocumentAgreements } from './DocumentAgreements';
import type { DocumentHostComponents, DocumentSlots } from './hostComponents';

function Slot({ name, children }: { name: string; children?: DocumentSlots[keyof DocumentSlots] }): ReactElement {
  // empty:hidden — an empty slot must not add a `space-y` gap inside the paper.
  return <div data-slot={name} className="empty:hidden">{children}</div>;
}

/** The agreements a signature checkbox names, each linking to its row. */
export function quoteAgreementLinks(model: Pick<QuoteDocumentModel, 'agreements'>): { label: string; href: string }[] {
  return model.agreements.map((a) => ({ label: a.title, href: `#${a.anchor}` }));
}

/** One proposal, rendered from the customer quote model. Every surface (web Preview,
 *  public link, logged-in portal) renders through this component; the host owns the
 *  sign / accept panel (`slots.signature`) and what surrounds the paper. */
export function QuoteDocumentView({
  model, components, slots,
}: {
  model: QuoteDocumentModel;
  components: DocumentHostComponents;
  slots?: DocumentSlots;
}): ReactElement {
  return (
    <>
      <Slot name="before-paper">{slots?.beforePaper}</Slot>
      <DocumentPaper theme={model.branding.theme}>
        {model.cover && <DocumentCover cover={model.cover} pageSize={model.branding.pageSize} components={components} />}
        <DocumentHeader header={model.header} branding={model.branding} components={components} titleAs={model.cover ? 'h2' : 'h1'} />
        {model.introNotes && (
          <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">{model.introNotes}</p>
        )}
        <QuoteBlocks blocks={model.blocks} components={components} />
        <DocumentTotals totals={model.totals} />
        <Slot name="after-totals">{slots?.afterTotals}</Slot>
        {model.terms.short && <DocumentNotes label={model.terms.short.label} text={model.terms.short.text} testId="document-terms-short" />}
        {/* The sign panel sits directly after the price and short terms; the (collapsed)
            agreements never come between the totals and the button. */}
        <Slot name="signature">{slots?.signature}</Slot>
        <DocumentAgreements agreements={model.agreements} labels={model.agreementLabels} components={components} />
        {model.footer && (
          <footer className="border-t pt-6 text-center text-xs leading-relaxed text-muted-foreground">{model.footer}</footer>
        )}
      </DocumentPaper>
      <Slot name="after-paper">{slots?.afterPaper}</Slot>
    </>
  );
}

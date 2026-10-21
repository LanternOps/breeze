import type { ReactElement } from 'react';
import type { InvoiceDocumentModel } from '@breeze/shared/documents';
import { DocumentPaper } from './DocumentPaper';
import { DocumentHeader } from './DocumentHeader';
import { DocumentLineTable } from './DocumentLineTable';
import { DocumentTotals } from './DocumentTotals';
import { DocumentNotes } from './DocumentNotes';
import { DocumentTerms } from './DocumentTerms';
import type { DocumentHostComponents, DocumentSlots } from './hostComponents';

export type { DocumentSlots };

function Slot({ name, children }: { name: string; children?: DocumentSlots[keyof DocumentSlots] }): ReactElement {
  // empty:hidden — an empty slot must not add a `space-y` gap inside the paper.
  return <div data-slot={name} className="empty:hidden">{children}</div>;
}

/** One invoice, rendered from the customer document model. Every surface (web
 *  Preview, public link, logged-in portal) renders through this component. */
export function InvoiceDocumentView({
  model, components, slots,
}: {
  model: InvoiceDocumentModel;
  components: DocumentHostComponents;
  slots?: DocumentSlots;
}): ReactElement {
  return (
    <>
      <Slot name="before-paper">{slots?.beforePaper}</Slot>
      <DocumentPaper theme={model.branding.theme}>
        <DocumentHeader header={model.header} branding={model.branding} components={components} />
        <DocumentLineTable table={model.lines} components={components} />
        <DocumentTotals totals={model.totals} />
        <Slot name="after-totals">{slots?.afterTotals}</Slot>
        <Slot name="signature">{slots?.signature}</Slot>
        {model.notes && <DocumentNotes label={model.sectionLabels.notes} text={model.notes} testId="document-notes" />}
        <DocumentTerms terms={model.terms} shortLabel={model.sectionLabels.terms} />
        {model.footer && (
          <footer className="border-t pt-6 text-center text-xs leading-relaxed text-muted-foreground">{model.footer}</footer>
        )}
      </DocumentPaper>
      <Slot name="after-paper">{slots?.afterPaper}</Slot>
    </>
  );
}

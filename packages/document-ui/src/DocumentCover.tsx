import type { ReactElement } from 'react';
import type { QuoteCoverModel } from '@breeze/shared/documents';
import type { DocumentHostComponents } from './hostComponents';

/**
 * The proposal's cover, on screen: the page frame the PDF has always drawn as the
 * first page. It carries the page's H1 (the header's number steps down to an h2), the
 * cover image when one is set, and prepared for / prepared by. Geometry is the portal's
 * current cover (W4 reworks it); the negative margins bleed it to the paper edge, so
 * they must match DocumentPaper's padding (`px-4 py-7`, plus the article's `sm:px-[3.25rem]`).
 */
export function DocumentCover({ cover, components }: { cover: QuoteCoverModel; components: DocumentHostComponents }): ReactElement {
  return (
    <section data-testid="document-cover" className="-mx-4 -mt-7 border-b sm:-mx-[4.25rem] sm:-mt-9">
      {cover.image && (
        <components.Image asset={cover.image} alt="" className="h-48 w-full object-cover sm:h-64" />
      )}
      <div className="space-y-6 px-4 py-8 sm:px-[4.25rem] sm:py-12">
        <div className="space-y-3">
          <p className="doc-accent-text text-xs font-semibold uppercase tracking-[0.18em]">{cover.eyebrow}</p>
          <h1 className="doc-font-display max-w-[24ch] text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl">
            {cover.title}
          </h1>
        </div>
        {(cover.preparedFor || cover.preparedBy) && (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            {cover.preparedFor && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cover.preparedForLabel}</dt>
                <dd className="mt-1 font-medium text-foreground">{cover.preparedFor}</dd>
              </div>
            )}
            {cover.preparedBy && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{cover.preparedByLabel}</dt>
                <dd className="mt-1 font-medium text-foreground">{cover.preparedBy}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

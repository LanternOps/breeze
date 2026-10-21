import type { ReactElement } from 'react';
import type { DocumentPageSize, QuoteCoverModel } from '@breeze/shared/documents';
import type { DocumentHostComponents } from './hostComponents';
import { DocumentCoverCrop } from './DocumentCoverCrop';

/**
 * The proposal's cover, on screen: the page the PDF draws first. It carries the page's H1
 * (the header's number steps down to an h2), the cover image when one is set, and prepared
 * for / prepared by. With an image it IS the PDF page (OD-5): a page-aspect frame
 * (`branding.pageSize`), the artwork centre-cropped, and the title block in the white band
 * from 62% of the height. Without artwork there is nothing to crop, so the text flows as before.
 * The negative margins bleed it to the paper edge, so they must match DocumentPaper's
 * padding (`px-4 py-7`, plus the article's `sm:px-[3.25rem]`).
 */
export function DocumentCover({ cover, pageSize, components }: { cover: QuoteCoverModel; pageSize: DocumentPageSize; components: DocumentHostComponents }): ReactElement {
  // The band is a fixed 38% of the page, so on a phone its type is smaller than the flowing layout's.
  const inBand = cover.image !== null;
  const text = (
    <>
      <div className="space-y-2 sm:space-y-3">
        <p className="doc-accent-text text-xs font-semibold uppercase tracking-[0.18em]">{cover.eyebrow}</p>
        <h1 className={`doc-font-display max-w-[24ch] font-semibold leading-tight tracking-tight text-foreground sm:text-4xl ${inBand ? 'text-xl' : 'text-3xl'}`}>
          {cover.title}
        </h1>
      </div>
      {(cover.preparedFor || cover.preparedBy) && (
        <dl className={`grid gap-4 ${inBand ? 'grid-cols-2 text-xs sm:text-sm' : 'text-sm sm:grid-cols-2'}`}>
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
    </>
  );
  const bleed = '-mx-4 -mt-7 border-b sm:-mx-[4.25rem] sm:-mt-9';
  if (!cover.image) {
    return (
      <section data-testid="document-cover" className={bleed}>
        <div className="space-y-6 px-4 py-8 sm:px-[4.25rem] sm:py-12">{text}</div>
      </section>
    );
  }
  return (
    <section data-testid="document-cover" className={bleed}>
      <DocumentCoverCrop pageSize={pageSize}>
        <components.Image asset={cover.image} alt="" className="doc-cover-image" />
        <div data-testid="document-cover-band" className="doc-cover-band space-y-4 px-4 py-3 sm:space-y-6 sm:px-[4.25rem] sm:py-8">
          {text}
        </div>
      </DocumentCoverCrop>
    </section>
  );
}

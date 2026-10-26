import type { ReactElement, ReactNode } from 'react';
import type { DocumentPageSize } from '@breeze/shared/documents';

/** The cover's page-aspect frame (OD-5): classes live in `document.css`. The document's
 *  cover and the quote editor's cover-image preview both render through this, so the crop
 *  the author sees is the crop the customer gets. Children place themselves absolutely
 *  (the image wears `doc-cover-image`; the band, `doc-cover-band`). */
export function DocumentCoverCrop({ pageSize, children, className = '', testId = 'document-cover-frame' }: {
  pageSize: DocumentPageSize;
  children: ReactNode;
  className?: string;
  testId?: string;
}): ReactElement {
  return (
    <div data-testid={testId} className={`doc-cover-frame ${pageSize === 'letter' ? 'doc-cover-letter' : 'doc-cover-a4'} ${className}`.trim()}>
      {children}
    </div>
  );
}

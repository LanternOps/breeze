import type { ReactElement, ReactNode } from 'react';
import type { DocumentAssetRef } from '@breeze/shared/documents';

/** What a host app supplies because it alone knows how to fetch an asset
 *  (authenticated object URL on web, plain URL on the portal). */
export interface DocumentHostComponents {
  Image(props: { asset: DocumentAssetRef; alt: string; className?: string }): ReactElement | null;
  AgreementFile(props: { asset: DocumentAssetRef; title: string }): ReactElement | null;
}

/** Host-owned regions the document leaves open. Each renders inside a
 *  `<div data-slot="…">` (an empty div when absent) so normalized markup is stable. */
export interface DocumentSlots {
  beforePaper?: ReactNode;
  afterTotals?: ReactNode;
  signature?: ReactNode;
  afterPaper?: ReactNode;
}

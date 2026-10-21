import type { ReactElement, ReactNode } from 'react';
import type { DocumentAssetRef } from '@breeze/shared/documents';

/** What a host app supplies because it alone knows how to fetch an asset
 *  (authenticated object URL on web, plain URL on the portal). */
export interface DocumentHostComponents {
  Image(props: {
    asset: DocumentAssetRef;
    alt: string;
    className?: string;
    /** The author's width for a block image, passed as the `width` attribute (never a style). */
    width?: number;
    /** What to print if the asset cannot be fetched; hosts that render nothing on a miss may ignore it. */
    unavailableText?: string;
  }): ReactElement | null;
  /** An uploaded agreement's PDF: an embedded viewer plus a download link. */
  AgreementFile(props: { asset: DocumentAssetRef; title: string; downloadLabel: string; unavailableText: string }): ReactElement | null;
}

/** Host-owned regions the document leaves open. Each renders inside a
 *  `<div data-slot="…">` (an empty div when absent) so normalized markup is stable. */
export interface DocumentSlots {
  beforePaper?: ReactNode;
  afterTotals?: ReactNode;
  signature?: ReactNode;
  afterPaper?: ReactNode;
}

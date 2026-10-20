import { DOCUMENT_LABELS_EN } from './en';
import type { DocumentLabels } from './types';

export { DOCUMENT_LABELS_EN };
export type { DocumentLabels, DocumentRichParts } from './types';

/**
 * The label map for a document locale. W1 ships English only, so every locale
 * resolves to it (the portal's behaviour today); W3a adds pt-BR here.
 */
export function documentLabelsFor(_locale: string): DocumentLabels {
  return DOCUMENT_LABELS_EN;
}

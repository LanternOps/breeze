import { DOCUMENT_LABELS_EN } from './en';
import { DOCUMENT_LABELS_PT_BR } from './pt-BR';
import type { DocumentLabels } from './types';

export { DOCUMENT_LABELS_EN, DOCUMENT_LABELS_PT_BR };
export type { DocumentLabels, DocumentRichParts } from './types';

const BY_LOCALE: Readonly<Record<string, DocumentLabels>> = Object.freeze({
  'pt-br': DOCUMENT_LABELS_PT_BR,
});

/**
 * The label map for a document locale. A locale without document labels falls
 * back to English on every surface (what the portal does today). OD-3.
 */
export function documentLabelsFor(locale: string): DocumentLabels {
  return BY_LOCALE[String(locale ?? '').toLowerCase()] ?? DOCUMENT_LABELS_EN;
}

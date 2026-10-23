/**
 * Quote-only view-model types (spec §3.2, #9418 W2a). Built only from the
 * customer quote DTO (`quoteDto.ts`) by `buildQuoteDocumentModel`; W2b renders
 * them. Shared primitives (money, header, line table, totals, branding) live in
 * `model.ts`.
 *
 * Additions to spec §3.2, because components hold no strings: the image block
 * carries its `unavailableText`; agreement bodies carry their unavailable and
 * download text; `AgreementBody` gains a `terms` variant for the Terms &
 * Conditions row (plain text, sectioned by the component).
 */
import type {
  DocumentAssetRef, DocumentBranding, DocumentHeaderModel, DocumentLineTableModel, DocumentTotalsModel, SanitizedHtml,
} from './model';

export interface QuoteTableBlock {
  columns: { label: SanitizedHtml; align: 'left' | 'center' | 'right' }[];
  rows: { key: string; cells: SanitizedHtml[] }[];   // builder asserts cells.length === columns.length
  headerStyle: 'plain' | 'tinted';
  zebra: boolean;
  caption: string | null;
}

export type QuoteBlockModel =
  | { kind: 'heading'; key: string; level: 1 | 2 | 3; text: string }
  | { kind: 'rich_text'; key: string; html: SanitizedHtml }
  | { kind: 'table'; key: string; table: QuoteTableBlock }               // alignment as classes, never style
  | { kind: 'callout'; key: string; tone: 'neutral' | 'warn' | 'accent'; title: string | null; html: SanitizedHtml }
  | { kind: 'image'; key: string; image: DocumentAssetRef | null; alt: string; caption: string | null; width: number | null; unavailableText: string }
  | { kind: 'line_items'; key: string; table: DocumentLineTableModel };
// Contract blocks are not body blocks (they render null in the body today); they appear only in `agreements`, in block order.

export type AgreementBody =
  | { kind: 'authored'; html: SanitizedHtml | null; footer: string; unavailableText: string }
  | {
      kind: 'uploaded';
      /** Lazy-mounted by the host's AgreementFile component. */
      file: DocumentAssetRef | null;
      /** The embedded file's accessible title (the template name). */
      fileTitle: string;
      footer: string;
      downloadLabel: string;
      unavailableText: string;
    }
  | { kind: 'terms'; text: string };

export interface QuoteAgreementModel {
  id: string;
  /** The deep-link target the signature slot links to. */
  anchor: `agreement-${string}` | 'terms';
  title: string;
  meta: string;
  body: AgreementBody;
}

export interface QuoteCoverModel {
  title: string;
  image: DocumentAssetRef | null;
  preparedFor: string | null;
  preparedBy: string | null;
  eyebrow: string;
  preparedForLabel: string;
  preparedByLabel: string;
}

export interface QuoteDocumentModel {
  kind: 'quote';
  locale: string;
  branding: DocumentBranding;
  cover: QuoteCoverModel | null;
  header: DocumentHeaderModel;
  introNotes: string | null;
  blocks: QuoteBlockModel[];         // includes the trailing default pricing table for un-blocked lines
  totals: DocumentTotalsModel;
  terms: { short: { label: string; text: string } | null };
  agreements: QuoteAgreementModel[];
  /** The list heading and the per-row toggle words (components hold no strings). */
  agreementLabels: { heading: string; read: string; hide: string };
  footer: string | null;
}

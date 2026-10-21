/**
 * The customer quote DTO (spec §3.4, #9418 W2a): exactly what
 * `apps/api/src/services/customerQuoteDocument.ts` (`assembleCustomerQuoteDocument`)
 * sends to the public proposal link, the logged-in portal and the staff Preview
 * (`GET /quotes/:id/customer-view`). Every field here leaves the server for a
 * customer, so adding one is a visibility decision.
 *
 * The shape is the public link's payload as it was before the assembler
 * existed (`quotesPublic.customerDocumentPin.test.ts` pins it), plus
 * `displayStatus` and `documentLocale`.
 */
import type { DocumentPageSize, DocumentThemeId, PublicQuoteHeader } from '../types/publicQuote';
import type { SanitizedHtml } from './model';

export type CustomerQuoteStatus =
  | 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted' | 'superseded';

/** The pill the customer's public link would show: `sent` reads as `viewed`
 *  (the public mapping), and a draft has none. */
export type CustomerQuoteDisplayStatus = Exclude<CustomerQuoteStatus, 'draft' | 'sent'>;

export interface CustomerQuoteHeaderDto extends Omit<PublicQuoteHeader, 'status'> {
  /** `public` mode: the public mapping (`sent` → `viewed`); `portal`/`staff`: the raw status. */
  status: CustomerQuoteStatus;
  displayStatus: CustomerQuoteDisplayStatus | null;
}

/** The authored contract block as every customer surface receives it
 *  (`renderContractBlocksForClient`): never the authoring fields. */
export interface CustomerContractBlockContent {
  label?: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: SanitizedHtml | null;
  /** Host-specific path to the uploaded PDF (the route supplies it). */
  fileUrl: string | null;
}

interface CustomerQuoteBlockBase {
  id: string;
  quoteId: string;
  orgId: string;
  sortOrder: number;
  /** ISO timestamp — what JSON.stringify sends for the row's Date. */
  createdAt: string;
}

/**
 * A quote block after the server's read sanitizer (`sanitizeQuoteBlocksForRead`)
 * and contract render. Every HTML-bearing field is `SanitizedHtml`, cast in one
 * place in the assembler. The typing describes what the sanitizer guarantees;
 * the builder still narrows defensively, since a legacy row can carry less.
 */
export type CustomerQuoteBlockDto = CustomerQuoteBlockBase & (
  | { blockType: 'heading'; content: { text?: string; level?: number } }
  | { blockType: 'rich_text'; content: { html?: SanitizedHtml } }
  | { blockType: 'image'; content: { imageId?: string; caption?: string; width?: number } }
  | { blockType: 'line_items'; content: { label?: string; showSubtotal?: boolean } }
  | {
      blockType: 'table';
      content: {
        columns: { label: SanitizedHtml; align?: 'left' | 'center' | 'right' }[];
        rows: { cells: SanitizedHtml[] }[];
        caption?: string;
        zebra?: boolean;
        headerStyle?: 'accent' | 'plain';
      };
    }
  | { blockType: 'callout'; content: { variant: 'info' | 'accent' | 'warn'; title?: string; html: SanitizedHtml } }
  | { blockType: 'contract'; content: CustomerContractBlockContent }
);

export type CustomerQuoteBlockType = CustomerQuoteBlockDto['blockType'];

/**
 * A customer-visible quote line: `CUSTOMER_LINE_FIELDS` (`quoteService.ts`, an
 * allowlist) minus the internal image identifiers, plus the host's thumbnail
 * path. Never `unitCost` or the procurement snapshot.
 */
export interface CustomerQuoteLineDto {
  id: string;
  quoteId: string;
  blockId: string | null;
  orgId: string;
  sourceType: 'catalog' | 'bundle' | 'manual';
  parentLineId: string | null;
  name: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  recurrence: 'one_time' | 'monthly' | 'annual';
  termMonths: number | null;
  billingFrequency: string | null;
  depositEligible: boolean;
  itemType: string | null;
  sku: string | null;
  partNumber: string | null;
  sortOrder: number;
  createdAt: string;
  contractLineType: 'per_device' | 'per_device_role' | 'per_device_group' | 'per_seat' | null;
  deviceRoles: string[] | null;
  deviceGroupName: string | null;
  siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: string | null;
  /** Host-specific thumbnail path, or null when the line has no image. */
  imageUrl: string | null;
  /** OD-9 (#9402): present only when the assembler's projection enables bundle nesting. */
  isChild?: boolean;
}

export interface CustomerQuoteBrandingDto {
  /** Null when the partner row is missing; each route applies its own envelope fallback. */
  partnerName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  theme: DocumentThemeId;
  pageSize: DocumentPageSize;
}

export interface CustomerQuoteDocument {
  quote: CustomerQuoteHeaderDto;
  blocks: CustomerQuoteBlockDto[];
  lines: CustomerQuoteLineDto[];
  branding: CustomerQuoteBrandingDto;
  /** `quote.documentLocale ?? partner locale ?? 'en'` (spec §3.7). */
  documentLocale: string;
}

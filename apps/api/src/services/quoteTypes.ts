import type { z } from 'zod';
import { quoteStatusSchema } from '@breeze/shared';

// Single source of truth for the quote status union lives in the shared Zod
// schema (validators/quotes.ts); infer the type here rather than re-declaring it.
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

export interface QuoteActor {
  /** The user who initiated the action, or null for system/background actors. */
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export type QuoteServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ORG_DENIED'
  | 'QUOTE_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'LINE_NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'IMAGE_NOT_FOUND'
  | 'INVALID_IMAGE'
  | 'CATALOG_ITEM_NOT_FOUND'
  | 'INVALID_STATE';

export class QuoteServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: QuoteServiceErrorCode
  ) {
    super(message);
    this.name = 'QuoteServiceError';
  }
}

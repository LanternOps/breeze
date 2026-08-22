export type ContractStatus = 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
export type ContractLineType = 'flat' | 'per_device' | 'per_seat' | 'manual';
export type BillingTiming = 'advance' | 'arrears';

export interface ContractActor {
  userId: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export interface Period {
  periodStart: string; // ISO YYYY-MM-DD (inclusive)
  periodEnd: string;   // ISO YYYY-MM-DD (exclusive)
}

export type ContractServiceErrorCode =
  | 'ORG_DENIED'
  | 'CONTRACT_NOT_FOUND'
  | 'CONTRACT_CREATE_FAILED'
  | 'CONTRACT_LINE_CREATE_FAILED'
  | 'NOT_A_DRAFT'
  // Draft currency immutability (#3774): changeContractCurrency refused because
  // contract lines exist and the caller didn't opt into clearLines.
  | 'CURRENCY_LOCKED'
  // Multi-currency wave 3 (#3775): addContractLineToContract found no price-book
  // row (and no org override) for the catalog item in the contract's currency.
  // Mapped 409 from CatalogServiceError — never converted; add a non-catalog
  // line or fill the price book.
  | 'NO_PRICE_FOR_CURRENCY'
  | 'PRICE_NOT_REPRESENTABLE'
  | 'NO_LINES'
  | 'INVALID_STATE'
  | 'LINE_NOT_FOUND'
  | 'ALREADY_BILLED'
  | 'NOTHING_DUE';

export class ContractServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: ContractServiceErrorCode
  ) {
    super(message);
    this.name = 'ContractServiceError';
  }
}

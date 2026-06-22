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

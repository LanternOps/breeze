import type { ContractLineType } from '@breeze/shared';

export type ContractStatus = 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
export type BillingTiming = 'advance' | 'arrears';

export interface ContractActor {
  userId: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * Verified permission evidence from the authenticated context, as
   * `"<resource>:<action>"` strings (e.g. `"contracts:manage"`). Populated by
   * `contractActorFrom()` from the request's resolved permissions.
   *
   * FAIL-CLOSED BY CONSTRUCTION: a caller that cannot prove a permission passes
   * nothing and is DENIED — never defaulted to allow. System/background callers
   * (contractWorker, generateDueInvoice) therefore can never reach the
   * ACTIVE-contract currency restamp (#3778).
   */
  permissions?: ReadonlySet<string>;
}

/** True only when the actor carries verified evidence of `<resource>:<action>`. */
export const actorCan = (
  a: ContractActor,
  p: { resource: string; action: string }
): boolean => a.permissions?.has(`${p.resource}:${p.action}`) === true;

export interface Period {
  periodStart: string; // ISO YYYY-MM-DD (inclusive)
  periodEnd: string;   // ISO YYYY-MM-DD (exclusive)
}

export type ContractServiceErrorCode =
  | 'ORG_DENIED'
  // #3778 (finding 1): the organization is gone at the locking read that opens
  // every creation transaction. Distinct from CONTRACT_NOT_FOUND — the contract
  // was never created because its ORG does not exist / is invisible.
  | 'ORG_NOT_FOUND'
  // #3205: a line's siteId names a site owned by a different organization.
  | 'SITE_NOT_IN_ORG'
  // #3205 W02: a line's deviceGroupId names a group owned by a different organization.
  | 'GROUP_NOT_IN_ORG'
  // #3205 W02: a dynamic group's filter could not be evaluated (malformed, engine
  // error, 500 ms timeout). Never a zero count — generation aborts, list degrades.
  | 'GROUP_EVALUATION_FAILED'
  // #3205 W02: a per_device_group line whose group was deleted (device_group_id
  // NULL). Reads show it unresolved; generation refuses.
  | 'GROUP_DELETED'
  // #4693: a formerly site-scoped device line whose site was deleted.
  | 'SITE_DELETED'
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
  | 'NOTHING_DUE'
  // ---- Multi-currency wave 6 (#3778): ACTIVE-contract currency restamp ----
  // The caller did not pass confirmActiveChange on a non-draft contract.
  | 'ACTIVE_CHANGE_CONFIRMATION_REQUIRED'
  // The actor lacks contracts:manage (the same gate manual generation uses).
  | 'ACTIVE_CHANGE_FORBIDDEN'
  // The contract owns draft invoices / draft contract-source lines it would
  // strand in the old currency. `details` carries the offending ids.
  | 'UNBILLED_MONETARY_ROWS'
  // A contract_billing_periods row has no invoice, or points at a missing one.
  | 'ORPHANED_BILLING_PERIOD'
  // A source_type='contract' invoice line the service cannot attribute to any
  // contract (NULL source_contract_id AND a dangling source_id). Conservative
  // org-wide blocker — refuse rather than guess.
  | 'ORPHANED_CONTRACT_SOURCE'
  // A billing period's invoice fails the explicit lineage check (cross-tenant,
  // unattributable, or a cyclic/over-deep replaces_invoice_id ancestry).
  | 'BROKEN_CONTRACT_LINEAGE'
  // #3205 W03: the patch, merged onto the current row, violates a contract-line
  // invariant (roles on a non-role line, a site on a group line, an unlink with
  // no price, a refresh with no link). `details.issues` carries the failing
  // paths. Distinct from INVALID_STATE, which is about the CONTRACT's status.
  | 'INVALID_LINE_PATCH'
  // #3205 W03: resolvePrice could not reach the catalog item. Deliberately does
  // NOT distinguish missing / foreign / RLS-invisible (catalogService.ts:680) —
  // a 404 that fires only for foreign ids enumerates other partners' catalogs.
  | 'CATALOG_ITEM_NOT_FOUND';

export class ContractServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: ContractServiceErrorCode,
    /**
     * Structured, non-secret payload returned verbatim by handleContractError.
     * Wave 6 (#3778) uses it to name the exact rows blocking a restamp so the
     * operator can act on them instead of guessing.
     */
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ContractServiceError';
  }
}

/**
 * #3205 W03: what a line mutation tells the audit log. Both doors write it —
 * the HTTP route through writeRouteAudit, the AI tool through writeAuditEvent
 * with initiatedBy: 'ai'.
 *
 * NO FREE TEXT. No description, no site name, no group name: the audit log is
 * queryable by support and none of that is incident data (same reasoning as the
 * recipient-count rule at routes/invoices/lifecycle.ts:70-72).
 */
export interface ContractLineAudit {
  orgId: string;
  contractId: string;
  /** Absent on `contract.line.added`: the add path derives its payload from the
   *  inserted row, which carries no contract name, and its signature is
   *  deliberately unchanged. Becomes the audit event's resourceName when set. */
  contractName?: string;
  contractLineId: string;
  lineType: ContractLineType;
  /** Column NAMES whose persisted value changed. Empty on a no-op patch.
   *  Absent for add/remove. Never a value — see the no-free-text rule. */
  changedFields?: string[];
  oldUnitPrice?: string;   // only when unitPrice changed
  newUnitPrice?: string;   // also set on add
}

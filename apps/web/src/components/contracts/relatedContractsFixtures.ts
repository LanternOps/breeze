import type { RelatedContract } from '@breeze/shared';
import type { ContractDetail, ContractStatus } from '../../lib/api/contracts';

/** Test fixtures for the #9303 related-contracts notice + activate confirm. */
export function relatedDetail(status: ContractStatus, relatedContracts?: RelatedContract[]): ContractDetail {
  return {
    autopayEnabled: false,
    contract: {
      autopayExcluded: false,
      id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Quote Q-1 (monthly)', status,
      billingTiming: 'advance', intervalMonths: 1, startDate: '2026-10-01', endDate: null,
      nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
      currencyCode: 'USD', notes: null, terms: null,
      createdBy: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    },
    lines: [
      {
        id: 'cl-1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Managed services',
        catalogItemId: null, unitPrice: '500.00', manualQuantity: null,
        includedQuantity: null, overageMode: null, overageUnitPrice: null,
        siteId: null, siteName: null, site: null, deviceRoles: null,
        deviceGroupId: null, deviceGroupName: null, deviceGroup: null, taxable: false,
        sortOrder: 0, createdAt: '2026-10-01T00:00:00Z',
      },
    ],
    periods: [],
    ...(relatedContracts ? { relatedContracts } : {}),
  };
}

export const overlappingSibling: RelatedContract = {
  id: 'ct-hand', name: 'Hand-built MSA', status: 'draft', intervalMonths: 1, currencyCode: 'USD',
  recurringTotal: '500.00', deliverableCount: 24, signedAgreementCount: 0, overlapsCadence: true,
};

export const unrelatedSibling: RelatedContract = {
  id: 'ct-annual', name: 'Annual licences', status: 'active', intervalMonths: 12, currencyCode: 'USD',
  recurringTotal: '1200.00', deliverableCount: 0, signedAgreementCount: 1, overlapsCadence: false,
};

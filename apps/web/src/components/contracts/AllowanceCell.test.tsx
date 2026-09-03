import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AllowanceCell from './AllowanceCell';
import type { ContractEstimateLine, ContractLine } from '../../lib/api/contracts';

const line = (siteName: string | null): ContractLine => ({
  id: 'line-1', contractId: 'contract-1', orgId: 'org-1', lineType: 'per_device',
  description: 'Endpoints', catalogItemId: null, unitPrice: '10.00', manualQuantity: null,
  siteId: null, siteName, site: null, deviceRoles: null, deviceGroupId: null,
  deviceGroupName: null, deviceGroup: null, includedQuantity: null, overageMode: null,
  overageUnitPrice: null, taxable: false, sortOrder: 0, createdAt: '2026-07-01T00:00:00Z',
});

const estimate = (unresolved: 'group_deleted' | 'site_deleted'): ContractEstimateLine => ({
  lineId: 'line-1', lineType: 'per_device', quantity: 0, value: '0.00', live: true,
  counted: 0, included: null, overage: 0, overageMode: null, overageValue: '0.00', unresolved,
});

describe('AllowanceCell unresolved scopes (#4693)', () => {
  it('keeps the deleted-group state distinct', () => {
    render(<AllowanceCell line={line(null)} estimate={estimate('group_deleted')} />);
    expect(screen.getByTestId('allowance-group-deleted')).toHaveTextContent('group deleted');
  });

  it('names the deleted site instead of rendering an org-wide quantity', () => {
    render(<AllowanceCell line={line('Dallas')} estimate={estimate('site_deleted')} />);
    expect(screen.getByTestId('allowance-site-deleted')).toHaveTextContent('site deleted: Dallas');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

vi.mock('../db/schema', () => ({
  contractLines: {
    id: 'contract_lines.id',
    orgId: 'contract_lines.org_id',
    lineType: 'contract_lines.line_type',
    manualQuantity: 'contract_lines.manual_quantity',
  },
  pax8ContractLineLinks: {
    subscriptionSnapshotId: 'pax8_contract_line_links.subscription_snapshot_id',
    contractLineId: 'pax8_contract_line_links.contract_line_id',
    integrationId: 'pax8_contract_line_links.integration_id',
    partnerId: 'pax8_contract_line_links.partner_id',
    orgId: 'pax8_contract_line_links.org_id',
    syncEnabled: 'pax8_contract_line_links.sync_enabled',
  },
  pax8Integrations: {
    id: 'pax8_integrations.id',
    partnerId: 'pax8_integrations.partner_id',
  },
  pax8SubscriptionSnapshots: {
    id: 'pax8_subscription_snapshots.id',
    integrationId: 'pax8_subscription_snapshots.integration_id',
    partnerId: 'pax8_subscription_snapshots.partner_id',
    orgId: 'pax8_subscription_snapshots.org_id',
    pax8SubscriptionId: 'pax8_subscription_snapshots.pax8_subscription_id',
    productName: 'pax8_subscription_snapshots.product_name',
    quantity: 'pax8_subscription_snapshots.quantity',
    quantityKnown: 'pax8_subscription_snapshots.quantity_known',
  },
}));

import { db } from '../db';
import { detectPax8Drift } from './pax8Drift';

function mockRows(rows: unknown[]) {
  const chain: Record<string, any> = {};
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn(() => chain) } as any);
  return chain;
}

describe('detectPax8Drift', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns exact Breeze and known Pax8 quantities in deterministic order', async () => {
    const rows = [{
      contractLineId: 'cl-1',
      orgId: 'org-1',
      pax8SubscriptionId: 'sub-1',
      productName: 'Product',
      breezeQuantity: '5.00',
      pax8Quantity: '8.00',
    }];
    const chain = mockRows(rows);

    await expect(detectPax8Drift({ partnerId: 'partner-1', integrationId: 'int-1' })).resolves.toEqual(rows);
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(1000);
  });

  it('returns no rows when quantities agree or quantity evidence is missing', async () => {
    mockRows([]);
    await expect(detectPax8Drift({ partnerId: 'partner-1', integrationId: 'int-1' })).resolves.toEqual([]);
  });
});

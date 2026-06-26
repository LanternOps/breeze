import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partner_id',
  },
  contractLines: {
    id: 'contract_lines.id',
    orgId: 'contract_lines.org_id',
    lineType: 'contract_lines.line_type',
    manualQuantity: 'contract_lines.manual_quantity',
  },
  pax8CompanyMappings: {
    integrationId: 'pax8_company_mappings.integration_id',
    partnerId: 'pax8_company_mappings.partner_id',
    pax8CompanyId: 'pax8_company_mappings.pax8_company_id',
    orgId: 'pax8_company_mappings.org_id',
    ignored: 'pax8_company_mappings.ignored',
    updatedAt: 'pax8_company_mappings.updated_at',
  },
  pax8ContractLineLinks: {
    id: 'pax8_contract_line_links.id',
    integrationId: 'pax8_contract_line_links.integration_id',
    partnerId: 'pax8_contract_line_links.partner_id',
    orgId: 'pax8_contract_line_links.org_id',
    subscriptionSnapshotId: 'pax8_contract_line_links.subscription_snapshot_id',
    contractLineId: 'pax8_contract_line_links.contract_line_id',
    syncEnabled: 'pax8_contract_line_links.sync_enabled',
    lastAppliedQuantity: 'pax8_contract_line_links.last_applied_quantity',
    lastAppliedAt: 'pax8_contract_line_links.last_applied_at',
    updatedAt: 'pax8_contract_line_links.updated_at',
  },
  pax8Integrations: {
    id: 'pax8_integrations.id',
    partnerId: 'pax8_integrations.partner_id',
  },
  pax8ProductMappings: {
    integrationId: 'pax8_product_mappings.integration_id',
    pax8ProductId: 'pax8_product_mappings.pax8_product_id',
  },
  pax8SubscriptionSnapshots: {
    id: 'pax8_subscription_snapshots.id',
    integrationId: 'pax8_subscription_snapshots.integration_id',
    partnerId: 'pax8_subscription_snapshots.partner_id',
    pax8CompanyId: 'pax8_subscription_snapshots.pax8_company_id',
    orgId: 'pax8_subscription_snapshots.org_id',
    quantity: 'pax8_subscription_snapshots.quantity',
  },
}));

vi.mock('./secretCrypto', () => ({
  decryptSecret: vi.fn((value: string | null | undefined) => value),
  encryptSecret: vi.fn((value: string | null | undefined) => value ? `enc:${value}` : null),
}));

import { db } from '../db';
import { applyEnabledPax8ContractLineLinks, linkPax8SubscriptionToContractLine, mapPax8Company, unlinkPax8Subscription } from './pax8SyncService';

function selectRowsOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  } as any);
}

function updateReturningOnce(rows: unknown[]) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValueOnce({ set } as any);
  return { set, where, returning };
}

function updateNoReturnOnce() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValueOnce({ set } as any);
  return { set, where };
}

function deleteReturningOnce(rows: unknown[]) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  vi.mocked(db.delete).mockReturnValueOnce({ where } as any);
  return { where, returning };
}

describe('pax8SyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a Pax8 company and propagates the org to existing subscription snapshots', async () => {
    selectRowsOnce([{ id: 'org-1', partnerId: 'partner-1' }]);
    updateReturningOnce([{ pax8CompanyId: 'company-1', orgId: 'org-1', ignored: false }]);
    const snapshotUpdate = updateNoReturnOnce();

    await expect(mapPax8Company({
      integrationId: 'integration-1',
      partnerId: 'partner-1',
      pax8CompanyId: 'company-1',
      orgId: 'org-1',
    })).resolves.toEqual({ pax8CompanyId: 'company-1', orgId: 'org-1', ignored: false });

    expect(snapshotUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }));
  });

  it('clears snapshot orgs when a Pax8 company is ignored', async () => {
    updateReturningOnce([{ pax8CompanyId: 'company-1', orgId: null, ignored: true }]);
    const snapshotUpdate = updateNoReturnOnce();

    await mapPax8Company({
      integrationId: 'integration-1',
      partnerId: 'partner-1',
      pax8CompanyId: 'company-1',
      orgId: null,
      ignored: true,
    });

    expect(snapshotUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ orgId: null }));
  });

  it('requires linked contract lines to be manual and in the mapped org', async () => {
    selectRowsOnce([{ id: 'snapshot-1', orgId: 'org-1', partnerId: 'partner-1', integrationId: 'integration-1' }]);
    selectRowsOnce([{ id: 'line-1', orgId: 'org-1', lineType: 'per_seat' }]);

    await expect(linkPax8SubscriptionToContractLine({
      integrationId: 'integration-1',
      partnerId: 'partner-1',
      subscriptionSnapshotId: 'snapshot-1',
      contractLineId: 'line-1',
      syncEnabled: true,
    })).rejects.toThrow('manual contract line');
  });

  it('writes orgId on Pax8 link upsert conflicts', async () => {
    selectRowsOnce([{ id: 'snapshot-1', orgId: 'org-1', partnerId: 'partner-1', integrationId: 'integration-1' }]);
    selectRowsOnce([{ id: 'line-1', orgId: 'org-1', lineType: 'manual' }]);
    selectRowsOnce([]); // pre-check: contract line not yet linked to another subscription

    const returning = vi.fn(async () => [{ id: 'link-1', orgId: 'org-1' }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    vi.mocked(db.insert).mockReturnValueOnce({ values } as any);

    await linkPax8SubscriptionToContractLine({
      integrationId: 'integration-1',
      partnerId: 'partner-1',
      subscriptionSnapshotId: 'snapshot-1',
      contractLineId: 'line-1',
      syncEnabled: true,
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ orgId: expect.any(Object) }),
    }));
  });

  describe('unlinkPax8Subscription', () => {
    it('deletes the link row and reports unlinked when a row matched', async () => {
      deleteReturningOnce([{ id: 'link-1' }]);

      const result = await unlinkPax8Subscription({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      });

      expect(result).toEqual({ unlinked: true });
    });

    it('reports unlinked:false when no row matched (idempotent)', async () => {
      deleteReturningOnce([]);

      const result = await unlinkPax8Subscription({
        integrationId: '44444444-4444-4444-4444-444444444444',
        subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
      });

      expect(result).toEqual({ unlinked: false });
    });
  });

  it('applies quantities only for valid manual same-org links', async () => {
    const joinChain = {
      innerJoin: vi.fn(() => joinChain),
      where: vi.fn(async () => [
        {
          linkId: 'link-1',
          contractLineId: 'line-1',
          linkOrgId: 'org-1',
          quantity: '12.00',
          lineType: 'manual',
          lineOrgId: 'org-1',
          subscriptionOrgId: 'org-1',
        },
        {
          linkId: 'link-2',
          contractLineId: 'line-2',
          linkOrgId: 'org-2',
          quantity: '5.00',
          lineType: 'manual',
          lineOrgId: 'org-1',
          subscriptionOrgId: 'org-1',
        },
      ]),
    };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => joinChain),
    } as any);
    const lineUpdate = updateNoReturnOnce();
    const linkUpdate = updateNoReturnOnce();

    await expect(applyEnabledPax8ContractLineLinks('integration-1')).resolves.toEqual({ applied: 1, skipped: 1 });
    expect(lineUpdate.set).toHaveBeenCalledWith({ manualQuantity: '12.00' });
    expect(linkUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ lastAppliedQuantity: '12.00' }));
  });
});

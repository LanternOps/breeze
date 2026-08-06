import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { computeEffectDigest } from './effectDigest';

/**
 * Generic fake `Database`: every `.select(...).from(...).where(...)` chain
 * resolves to the next array shifted off `queue`, whether the resolver calls
 * `.limit(1)` (single-row lookups) or `.orderBy(...)` (the quote-lines
 * fetch, which has no limit). Resolvers that issue N sequential queries
 * (manage_quotes:send: quote then lines; void_payment: payment then invoice)
 * consume the queue in call order — tests supply rows in that same order.
 */
function makeFakeDb(queue: unknown[][]): { database: Database; select: ReturnType<typeof vi.fn> } {
  const chain = {
    limit: vi.fn(async () => queue.shift() ?? []),
    orderBy: vi.fn(async () => queue.shift() ?? []),
  };
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => chain),
    })),
  }));
  return { database: { select } as unknown as Database, select };
}

describe('computeEffectDigest', () => {
  describe('unpinnable tools', () => {
    it('returns null for a tool with no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const result = await computeEffectDigest('list_scripts', { orgId: 'org-1' }, database);
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });

    it('returns null for a multiplexer tool whose action has no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const result = await computeEffectDigest('manage_quotes', { action: 'decline', quoteId: 'q-1' }, database);
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('run_script', () => {
    it('produces the same digest for the same script content', async () => {
      const args = { scriptId: 'script-1', deviceIds: ['device-1'] };
      const db1 = makeFakeDb([[{ content: '#!/bin/bash\necho hi' }]]);
      const db2 = makeFakeDb([[{ content: '#!/bin/bash\necho hi' }]]);
      const d1 = await computeEffectDigest('run_script', args, db1.database);
      const d2 = await computeEffectDigest('run_script', args, db2.database);
      expect(d1).not.toBeNull();
      expect(d1).toMatch(/^[0-9a-f]{64}$/);
      expect(d1).toBe(d2);
    });

    it('produces a different digest when the script body changed', async () => {
      const args = { scriptId: 'script-1', deviceIds: ['device-1'] };
      const before = makeFakeDb([[{ content: 'echo original' }]]);
      const after = makeFakeDb([[{ content: 'echo TAMPERED' }]]);
      const digestBefore = await computeEffectDigest('run_script', args, before.database);
      const digestAfter = await computeEffectDigest('run_script', args, after.database);
      expect(digestBefore).not.toBe(digestAfter);
    });

    it('returns null when scriptId is missing from args', async () => {
      const { database, select } = makeFakeDb([]);
      const result = await computeEffectDigest('run_script', { deviceIds: ['device-1'] }, database);
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });

    it('returns null when the script does not exist (deleted/typoed id)', async () => {
      const { database } = makeFakeDb([[]]);
      const result = await computeEffectDigest('run_script', { scriptId: 'ghost' }, database);
      expect(result).toBeNull();
    });
  });

  describe('manage_quotes:send', () => {
    const updatedAt = new Date('2026-08-01T00:00:00Z');

    it('hashes quote updated_at + line-item snapshot; a line edit changes the digest', async () => {
      const args = { action: 'send', quoteId: 'quote-1' };
      const before = makeFakeDb([
        [{ updatedAt }],
        [{ id: 'line-1', quantity: '1', unitPrice: '10.00', lineTotal: '10.00', sortOrder: 0 }],
      ]);
      const after = makeFakeDb([
        [{ updatedAt }], // header untouched
        [{ id: 'line-1', quantity: '2', unitPrice: '10.00', lineTotal: '20.00', sortOrder: 0 }], // qty changed
      ]);
      const digestBefore = await computeEffectDigest('manage_quotes', args, before.database);
      const digestAfter = await computeEffectDigest('manage_quotes', args, after.database);
      expect(digestBefore).not.toBeNull();
      expect(digestBefore).not.toBe(digestAfter);
    });

    it('returns null when the quote does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const result = await computeEffectDigest('manage_quotes', { action: 'send', quoteId: 'ghost' }, database);
      expect(result).toBeNull();
    });

    it('does not resolve for a different action on the same tool (e.g. update)', async () => {
      const { database, select } = makeFakeDb([]);
      const result = await computeEffectDigest('manage_quotes', { action: 'update', quoteId: 'quote-1' }, database);
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('manage_invoices', () => {
    it('issue hashes the invoice updated_at', async () => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await computeEffectDigest(
        'manage_invoices',
        { action: 'issue', invoiceId: 'inv-1' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('record_payment hashes the invoice updated_at', async () => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await computeEffectDigest(
        'manage_invoices',
        { action: 'record_payment', invoiceId: 'inv-1', payment: { amount: 10 } },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('void_payment resolves the owning invoice through the paymentId, then hashes its updated_at', async () => {
      const { database, select } = makeFakeDb([
        [{ invoiceId: 'inv-1' }], // invoice_payments lookup by paymentId
        [{ updatedAt: new Date('2026-08-01T00:00:00Z') }], // invoices lookup by invoiceId
      ]);
      const result = await computeEffectDigest(
        'manage_invoices',
        { action: 'void_payment', paymentId: 'pay-1' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(select).toHaveBeenCalledTimes(2);
    });

    it('void_payment returns null when the payment does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const result = await computeEffectDigest(
        'manage_invoices',
        { action: 'void_payment', paymentId: 'ghost' },
        database,
      );
      expect(result).toBeNull();
    });

    it('returns null for a non-approval-gated action (e.g. update_header)', async () => {
      const { database, select } = makeFakeDb([]);
      const result = await computeEffectDigest(
        'manage_invoices',
        { action: 'update_header', invoiceId: 'inv-1', patch: {} },
        database,
      );
      expect(result).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('manage_contracts', () => {
    it('activate hashes the contract updated_at', async () => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await computeEffectDigest(
        'manage_contracts',
        { action: 'activate', contractId: 'contract-1' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('cancel hashes the contract updated_at, differing when the contract revised', async () => {
      const before = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const after = makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z') }]]);
      const args = { action: 'cancel', contractId: 'contract-1' };
      const digestBefore = await computeEffectDigest('manage_contracts', args, before.database);
      const digestAfter = await computeEffectDigest('manage_contracts', args, after.database);
      expect(digestBefore).not.toBe(digestAfter);
    });
  });

  describe('manage_organizations:update_org', () => {
    it('hashes the current org status', async () => {
      const { database } = makeFakeDb([[{ status: 'active' }]]);
      const result = await computeEffectDigest(
        'manage_organizations',
        { action: 'update_org', orgId: 'org-1', status: 'suspended' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs when the org was suspended between creation and release', async () => {
      const active = makeFakeDb([[{ status: 'active' }]]);
      const suspended = makeFakeDb([[{ status: 'suspended' }]]);
      const args = { action: 'update_org', orgId: 'org-1' };
      const digestActive = await computeEffectDigest('manage_organizations', args, active.database);
      const digestSuspended = await computeEffectDigest('manage_organizations', args, suspended.database);
      expect(digestActive).not.toBe(digestSuspended);
    });

    it('returns null when the org does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const result = await computeEffectDigest(
        'manage_organizations',
        { action: 'update_org', orgId: 'ghost' },
        database,
      );
      expect(result).toBeNull();
    });
  });
});

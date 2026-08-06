import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import {
  computeEffectDigest,
  computeEffectDigestOutcome,
  effectDigestResolverKey,
  hasPinnedDigest,
} from './effectDigest';

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

/** A full `scripts` row as the run_script resolver selects it. */
const scriptRow = (overrides: Record<string, unknown> = {}) => ({
  orgId: 'org-1',
  language: 'bash',
  content: '#!/bin/bash\necho hi',
  timeoutSeconds: 300,
  runAs: 'user',
  ...overrides,
});

describe('computeEffectDigestOutcome', () => {
  describe('unpinnable tools → not_applicable', () => {
    it('returns not_applicable for a tool with no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('list_scripts', { orgId: 'org-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });

    it('returns not_applicable for a multiplexer tool whose action has no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'decline', quoteId: 'q-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  // The distinction the old `string | null` return conflated: "no resolver"
  // (expected) vs "a resolver existed and produced nothing" (a silently
  // unpinned intent). All three still store NULL; only these two are auditable.
  describe('unresolved outcomes are distinguishable from not_applicable', () => {
    it('reports missing_arg when the id argument is absent', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('run_script', { deviceIds: ['device-1'] }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });

    it('reports missing_arg when the id argument is present but not a string', async () => {
      const { database } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('run_script', { scriptId: 42 }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    });

    it('reports target_absent when the referenced row does not exist (deleted/typoed id)', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome('run_script', { scriptId: 'ghost' }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('run_script', () => {
    it('produces the same digest for an unchanged script row', async () => {
      const args = { scriptId: 'script-1', deviceIds: ['device-1'] };
      const d1 = await computeEffectDigestOutcome('run_script', args, makeFakeDb([[scriptRow()]]).database);
      const d2 = await computeEffectDigestOutcome('run_script', args, makeFakeDb([[scriptRow()]]).database);
      expect(d1.kind).toBe('pinned');
      expect(d1).toEqual({ kind: 'pinned', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(d1).toEqual(d2);
    });

    // FIX 4: `content` alone left run_as / language / timeout_seconds free to
    // change between approval and release with a byte-identical digest —
    // flipping run_as from `user` to `system` is a privilege escalation the
    // approver never saw.
    it.each([
      ['content', { content: 'echo TAMPERED' }],
      ['runAs', { runAs: 'system' }],
      ['language', { language: 'powershell' }],
      ['timeoutSeconds', { timeoutSeconds: 9000 }],
      ['orgId', { orgId: 'org-2' }],
    ])('changes the digest when %s changes', async (_field, mutation) => {
      const args = { scriptId: 'script-1', deviceIds: ['device-1'] };
      const before = await computeEffectDigest('run_script', args, makeFakeDb([[scriptRow()]]).database);
      const after = await computeEffectDigest(
        'run_script',
        args,
        makeFakeDb([[scriptRow(mutation)]]).database,
      );
      expect(before).not.toBeNull();
      expect(before).not.toBe(after);
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

    it('reports target_absent when the quote does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'send', quoteId: 'ghost' }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    it('does not resolve for a different action on the same tool (e.g. update)', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'update', quoteId: 'quote-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('manage_invoices', () => {
    // `void` is classified four_eyes alongside issue/record_payment/
    // void_payment (aiGuardrails.ts) but shipped with NO resolver — the gap
    // effectDigestCoverage.contract.test.ts now makes impossible to repeat.
    it.each(['issue', 'void', 'record_payment'])('%s hashes the invoice updated_at', async (action) => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await computeEffectDigest('manage_invoices', { action, invoiceId: 'inv-1' }, database);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('void detects a revision change between approval and release', async () => {
      const args = { action: 'void', invoiceId: 'inv-1' };
      const before = await computeEffectDigest(
        'manage_invoices',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]).database,
      );
      const after = await computeEffectDigest(
        'manage_invoices',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z') }]]).database,
      );
      expect(before).not.toBe(after);
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

    it('void_payment reports target_absent when the payment does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome(
        'manage_invoices',
        { action: 'void_payment', paymentId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    it('returns not_applicable for a non-approval-gated action (e.g. update_header)', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome(
        'manage_invoices',
        { action: 'update_header', invoiceId: 'inv-1', patch: {} },
        database,
      );
      expect(outcome).toEqual({ kind: 'not_applicable' });
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

    it('reports target_absent when the org does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome(
        'manage_organizations',
        { action: 'update_org', orgId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('manage_tickets:move_org', () => {
    it('pins the ticket org + status, not updated_at (comment churn must not trip it)', async () => {
      const args = { action: 'move_org', ticketId: 'ticket-1', targetOrgId: 'org-2' };
      const before = await computeEffectDigest(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-1', status: 'open' }]]).database,
      );
      const sameAfterAComment = await computeEffectDigest(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-1', status: 'open' }]]).database,
      );
      const afterSomeoneElseMovedIt = await computeEffectDigest(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-9', status: 'open' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).toBe(sameAfterAComment);
      expect(before).not.toBe(afterSomeoneElseMovedIt);
    });

    it('reports missing_arg without a ticketId', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome(
        'manage_tickets',
        { action: 'move_org', targetOrgId: 'org-2' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('execute_dr_plan', () => {
    it('pins the plan revision — a plan edited between approval and release changes the digest', async () => {
      const args = { planId: 'plan-1', executionType: 'failover' };
      const before = await computeEffectDigest(
        'execute_dr_plan',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z'), status: 'active' }]]).database,
      );
      const after = await computeEffectDigest(
        'execute_dr_plan',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z'), status: 'active' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).not.toBe(after);
    });

    it('reports target_absent for a deleted plan', async () => {
      const outcome = await computeEffectDigestOutcome(
        'execute_dr_plan',
        { planId: 'ghost', executionType: 'rehearsal' },
        makeFakeDb([[]]).database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('delete_tenant', () => {
    // The arg really is snake_case here (aiToolsOrgs.ts) — the resolver map
    // keys on the tool's actual spelling, not a normalized one.
    it('pins the partner name + status via the snake_case tenant_id arg', async () => {
      const args = { tenant_id: 'partner-1', confirmation_phrase: 'delete Acme permanently' };
      const before = await computeEffectDigest(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme', status: 'active' }]]).database,
      );
      const afterRename = await computeEffectDigest(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme Holdings', status: 'active' }]]).database,
      );
      const afterChurn = await computeEffectDigest(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme', status: 'churned' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).not.toBe(afterRename);
      expect(before).not.toBe(afterChurn);
    });

    it('reports missing_arg when tenant_id is absent (e.g. a camelCase typo)', async () => {
      const outcome = await computeEffectDigestOutcome(
        'delete_tenant',
        { tenantId: 'partner-1' },
        makeFakeDb([]).database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    });
  });
});

describe('computeEffectDigest (flattening wrapper the release paths use)', () => {
  it('flattens BOTH unpinnable outcomes to null, which is what the stored column can express', async () => {
    expect(await computeEffectDigest('list_scripts', {}, makeFakeDb([]).database)).toBeNull();
    expect(await computeEffectDigest('run_script', {}, makeFakeDb([]).database)).toBeNull();
    expect(await computeEffectDigest('run_script', { scriptId: 'ghost' }, makeFakeDb([[]]).database)).toBeNull();
  });

  it('returns the digest itself on pinned', async () => {
    const result = await computeEffectDigest(
      'run_script',
      { scriptId: 'script-1' },
      makeFakeDb([[scriptRow()]]).database,
    );
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('effectDigestResolverKey', () => {
  it('prefers the tool:action key over the whole-tool key', () => {
    expect(effectDigestResolverKey('manage_invoices', 'void')).toBe('manage_invoices:void');
  });

  it('falls back to the whole-tool key when the action has no pair entry', () => {
    expect(effectDigestResolverKey('run_script', undefined)).toBe('run_script');
    expect(effectDigestResolverKey('run_script', 'anything')).toBe('run_script');
  });

  it('returns null for an unpinnable surface', () => {
    expect(effectDigestResolverKey('google_suspend_user')).toBeNull();
    expect(effectDigestResolverKey('manage_invoices', 'update_header')).toBeNull();
  });
});

describe('hasPinnedDigest', () => {
  // The two release call sites used to disagree on `undefined`:
  // intentReleaseWorker tested `!== null` (fails CLOSED with a spurious
  // content_changed), aiAgentSdk tested truthiness (fails OPEN, skipping the
  // check). One predicate, one answer.
  it.each([
    [{ effectDigest: 'a'.repeat(64) }, true],
    [{ effectDigest: 'x' }, true],
    [{ effectDigest: null }, false],
    [{ effectDigest: undefined }, false],
    [{}, false],
    [{ effectDigest: '' }, false],
  ])('%j → %s', (intent, expected) => {
    expect(hasPinnedDigest(intent as { effectDigest?: string | null })).toBe(expected);
  });
});

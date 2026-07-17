import { describe, it, expect } from 'vitest';
import { computeQuoteSha256, type HashableContractPart } from './quoteContentHash';

const quote = { id: 'q1', quoteNumber: 'Q-2026-0001', status: 'sent', currencyCode: 'USD', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', taxTotal: '0.00', subtotal: '100.00' } as any;
const blocks = [{ id: 'b1', blockType: 'heading', content: { text: 'Proposal' }, sortOrder: 0 }] as any;
const lines = [{ id: 'l1', description: 'Setup', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 }] as any;

describe('computeQuoteSha256', () => {
  it('returns a stable 64-char hex hash for the same content', () => {
    const a = computeQuoteSha256(quote, blocks, lines, []);
    const b = computeQuoteSha256(quote, blocks, lines, []);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
  it('is order-independent on input arrays but content-sensitive', () => {
    const reordered = computeQuoteSha256(quote, blocks, [...lines].reverse(), []);
    expect(reordered).toBe(computeQuoteSha256(quote, blocks, lines, []));
  });
  it('changes when a line amount is tampered', () => {
    const tampered = [{ ...lines[0], unitPrice: '1.00', lineTotal: '1.00' }];
    expect(computeQuoteSha256(quote, blocks, tampered, [])).not.toBe(computeQuoteSha256(quote, blocks, lines, []));
  });
  it('ignores volatile workflow fields — status + quote number (C4)', () => {
    // The quote legitimately transitions sent→converted (and gets a number) during
    // accept; the content hash must NOT change, or a later re-verify false-positives.
    const evolved = { ...quote, status: 'converted', quoteNumber: 'Q-9999-9999' };
    expect(computeQuoteSha256(evolved, blocks, lines, [])).toBe(computeQuoteSha256(quote, blocks, lines, []));
  });
  it('hash is UNCHANGED for quotes without a deposit (backward compat with stored acceptances)', () => {
    const quote = { id: 'q1', currencyCode: 'USD', subtotal: '10.00', taxTotal: '0.00', total: '10.00',
      oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00' };
    const legacy = computeQuoteSha256(quote as any, [], [], []);
    const withNone = computeQuoteSha256({ ...quote, depositType: 'none', depositPercent: null, depositAmount: null } as any, [], [], []);
    expect(withNone).toBe(legacy);
  });
  it('deposit config and line eligibility change the hash', () => {
    const quote = { id: 'q1', currencyCode: 'USD', subtotal: '10.00', taxTotal: '0.00', total: '10.00',
      oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00' };
    const line = { id: 'l1', description: 'x', quantity: '1', unitPrice: '10.00', lineTotal: '10.00',
      recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 };
    const base = computeQuoteSha256(quote as any, [], [line as any], []);
    const withDeposit = computeQuoteSha256(
      { ...quote, depositType: 'percent', depositPercent: '30.00', depositAmount: '3.00' } as any, [], [line as any], []);
    const withFlag = computeQuoteSha256(quote as any, [], [{ ...line, depositEligible: true } as any], []);
    expect(withDeposit).not.toBe(base);
    expect(withFlag).not.toBe(base);
  });
});

describe('computeQuoteSha256 with contractParts (Task 12)', () => {
  it('hash is BYTE-IDENTICAL to the pre-contract implementation for an empty contractParts array (frozen fixture, backward compat)', () => {
    // Frozen fixture: the exact quote/blocks/lines from the top of this file,
    // hashed with the pre-Task-12 computeQuoteSha256(quote, blocks, lines) (3
    // args, no contractParts). This literal was captured from the CURRENT
    // (pre-change) implementation before the 4th parameter was added — see
    // task-12-report.md for provenance. Every stored quote_acceptances row was
    // signed under the 3-arg call, so this must never change. contractParts is
    // now a required 4th argument (callers pass [] explicitly), but an empty
    // array must still produce the byte-identical hash as the old 3-arg call.
    expect(computeQuoteSha256(quote, blocks, lines, [])).toBe(
      '5f62cb507bcadb0033a50f14130002854fc12bd4c3a7e453f26b75483dce988a'
    );
  });

  it('changes the hash when a resolved contract variable value changes', () => {
    const partA: HashableContractPart = {
      blockId: 'block-1',
      templateVersionSha256: 'versha-1',
      resolvedVariables: { 'client.name': 'Acme Co', governing_state: 'Texas' },
    };
    const partB: HashableContractPart = { ...partA, resolvedVariables: { ...partA.resolvedVariables, governing_state: 'Nevada' } };

    const hashA = computeQuoteSha256(quote, blocks, lines, [partA]);
    const hashB = computeQuoteSha256(quote, blocks, lines, [partB]);

    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(computeQuoteSha256(quote, blocks, lines, [])); // also diverges from the no-contract hash
  });

  it('is order-independent on contractParts (blocks) and on resolvedVariables (keys)', () => {
    const partOne: HashableContractPart = {
      blockId: 'block-1', templateVersionSha256: 'sha-1', resolvedVariables: { b: '2', a: '1' },
    };
    const partTwo: HashableContractPart = {
      blockId: 'block-2', templateVersionSha256: 'sha-2', resolvedVariables: { z: '9' },
    };
    const forward = computeQuoteSha256(quote, blocks, lines, [partOne, partTwo]);
    const reversedParts = computeQuoteSha256(quote, blocks, lines, [partTwo, partOne]);
    const reorderedVars = computeQuoteSha256(quote, blocks, lines, [
      { ...partOne, resolvedVariables: { a: '1', b: '2' } },
      partTwo,
    ]);

    expect(reversedParts).toBe(forward);
    expect(reorderedVars).toBe(forward);
  });

  it('a changed templateVersionSha256 (e.g. a republished template) changes the hash', () => {
    const part: HashableContractPart = { blockId: 'block-1', templateVersionSha256: 'sha-v1', resolvedVariables: {} };
    const republished: HashableContractPart = { ...part, templateVersionSha256: 'sha-v2' };
    expect(computeQuoteSha256(quote, blocks, lines, [part])).not.toBe(
      computeQuoteSha256(quote, blocks, lines, [republished])
    );
  });
});

import { describe, expect, it } from 'vitest';
import { proposalDispatchSnapshot } from './dispatchSnapshot';

const proposal = {
  id: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system',
  timeoutSeconds: 300, scannerVersion: '2026-09-11.1',
} as never;

describe('proposalDispatchSnapshot', () => {
  it('sorts device ids so the digest is order-independent', () => {
    const a = proposalDispatchSnapshot(proposal, ['b-id', 'a-id']);
    const b = proposalDispatchSnapshot(proposal, ['a-id', 'b-id']);
    expect(a.deviceIds).toEqual(['a-id', 'b-id']);
    expect(a).toEqual(b);
  });

  it('carries only pinned material — no lifecycle state', () => {
    expect(Object.keys(proposalDispatchSnapshot(proposal, ['a-id'])).sort()).toEqual([
      'contentDigest', 'deviceIds', 'language', 'proposalId', 'runAs', 'scannerVersion', 'timeoutSeconds',
    ]);
  });
});

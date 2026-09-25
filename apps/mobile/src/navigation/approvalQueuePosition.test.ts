import { describe, it, expect } from 'vitest';

import { selectQueuePosition } from './approvalTakeover';
import type { ApprovalRequest } from '../services/approvals';

function row(id: string, status: ApprovalRequest['status'] = 'pending'): ApprovalRequest {
  return {
    id,
    requestingClientLabel: 'c',
    requestingMachineLabel: null,
    actionLabel: 'a',
    actionToolName: 't',
    actionArguments: {},
    riskTier: 'low',
    riskSummary: 's',
    customerTenant: null,
    status,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decidedAt: null,
    decisionReason: null,
    isRecursive: false,
    createdAt: new Date().toISOString(),
  };
}

describe('selectQueuePosition (#6212)', () => {
  it('reports 1-based position among pending rows, ignoring non-pending ones', () => {
    const pending = [row('a'), row('x', 'expired'), row('b')];
    expect(selectQueuePosition({ pending, focusId: 'b' })).toEqual({ index: 2, total: 2 });
  });

  it('is null when nothing is focused', () => {
    expect(selectQueuePosition({ pending: [row('a')], focusId: null })).toBeNull();
  });
});

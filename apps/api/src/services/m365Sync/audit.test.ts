import { describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: { writeAuditEvent: vi.fn() },
}));

vi.mock('../auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: () => ({}),
}));

import { recordM365SyncRunEvent } from './audit';

const BASE = {
  orgId: 'org-1', connectionId: 'conn-1', domain: 'users' as const, generation: 1,
  correlationId: 'corr-1', truncated: false, inserted: 0, updated: 0, stale: 0, unchanged: 0,
};

describe('recordM365SyncRunEvent — outcome to audit `result` mapping (spec §7)', () => {
  it.each([
    ['success', 'success'],
    ['partial', 'success'],
    ['needs_consent', 'failure'],
    ['throttled', 'failure'],
    ['error', 'failure'],
  ] as const)('%s -> %s', (outcome, result) => {
    recordM365SyncRunEvent({ ...BASE, outcome });
    const [, event] = mocks.writeAuditEvent.mock.calls.at(-1)!;
    expect(event).toMatchObject({ result, action: 'm365.sync.run' });
  });
});

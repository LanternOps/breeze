import { describe, expect, it, vi, beforeEach } from 'vitest';

// Same pattern as monitorService.test.ts / monitorResolver's siblings in this
// folder: db.select is fully mocked so each ownership branch can be driven by
// hand without a live database, and importOriginal keeps the DB-context
// helpers the wider import graph relies on.
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../../db';
import { isMonitorAttachableToPolicy } from './monitorAttachability';

const mockSelect = db.select as unknown as ReturnType<typeof vi.fn>;

const MONITOR_ID = 'monitor-1';
const POLICY_ID = 'policy-1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PARTNER_A = 'partner-a';
const PARTNER_B = 'partner-b';

/** Chainable `db.select(...)` stand-in resolving to `rows` at `.limit()`. */
function chain<T>(rows: T[]) {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}

/**
 * Queue up the sequence of `db.select` calls the function under test makes:
 * monitor lookup, then policy lookup, then (only for the partner-monitor /
 * org-policy branch) the organization lookup.
 */
function queueSelects(...results: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  mockSelect.mockImplementation(() => chain(results[call++] ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isMonitorAttachableToPolicy (#5289)', () => {
  it('org monitor -> same org policy = true', async () => {
    queueSelects(
      [{ orgId: ORG_A, partnerId: null }],
      [{ orgId: ORG_A, partnerId: null }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(true);
  });

  it('org monitor -> different org policy = false', async () => {
    queueSelects(
      [{ orgId: ORG_A, partnerId: null }],
      [{ orgId: ORG_B, partnerId: null }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(false);
  });

  it('org monitor -> partner-wide policy = false', async () => {
    queueSelects(
      [{ orgId: ORG_A, partnerId: null }],
      [{ orgId: null, partnerId: PARTNER_A }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(false);
  });

  it('partner monitor -> policy of an org under that partner = true', async () => {
    queueSelects(
      [{ orgId: null, partnerId: PARTNER_A }],
      [{ orgId: ORG_A, partnerId: null }],
      [{ partnerId: PARTNER_A }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(true);
  });

  it('partner monitor -> policy of an org under a DIFFERENT partner = false', async () => {
    queueSelects(
      [{ orgId: null, partnerId: PARTNER_A }],
      [{ orgId: ORG_A, partnerId: null }],
      [{ partnerId: PARTNER_B }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(false);
  });

  it('partner monitor -> same partner\'s partner-wide policy = true', async () => {
    queueSelects(
      [{ orgId: null, partnerId: PARTNER_A }],
      [{ orgId: null, partnerId: PARTNER_A }],
    );
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(true);
  });

  it('monitor missing -> deny, without ever looking up the policy', async () => {
    queueSelects([]);
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('policy missing -> deny', async () => {
    queueSelects([{ orgId: ORG_A, partnerId: null }], []);
    await expect(isMonitorAttachableToPolicy(MONITOR_ID, POLICY_ID)).resolves.toBe(false);
  });
});

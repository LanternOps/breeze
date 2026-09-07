import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4952 — the /policies/:id/evaluate arm of the cross-tenant automation hole.
//
// evaluatePolicy runs BOTH on the background worker (system-scoped, genuinely
// allowed to resolve partner-wide automations) and inside the request that
// POSTs /policies/:id/evaluate. RLS is not the filter on either: the worker is
// system-scoped, and in the request path this PR's partner-wide SELECT branch
// makes partner-wide automation rows readable from an org context too. So the
// app-layer dual-axis arm `org_id IS NULL AND partner_id = <device org's
// partner>` IS the access check. Ungated, it let an ORG caller trigger another
// tenant's partner-wide automation (one run per evaluated device, versus the
// fleet-wide fan-out on /remediate).

const enqueueAutomationRunMock = vi.fn().mockResolvedValue({ enqueued: true });
vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: (...args: unknown[]) => enqueueAutomationRunMock(...args),
}));

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  resolveComplianceRulesForDevice: vi.fn(),
  scanDueComplianceChecks: vi.fn(),
}));

import {
  __triggerRemediationAutomation,
  resolvePolicyRemediationAutomationIdForOrg,
} from './policyEvaluationService';

const ORG_ID = 'oooooooo-oooo-oooo-oooo-oooooooooooo';
const PARTNER_ID = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const OTHER_PARTNER_ID = 'qqqqqqqq-qqqq-qqqq-qqqq-qqqqqqqqqqqq';
const AUTOMATION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_ID = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr';
const SCRIPT_ID = 'ssssssss-ssss-ssss-ssss-ssssssssssss';

const DEVICE = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  orgId: ORG_ID,
  hostname: 'WS-1',
  osType: 'windows',
  osVersion: '10.0.19045',
};

/** A partner-wide automation row (org_id NULL) owned by the device org's partner. */
const PARTNER_WIDE_AUTOMATION = {
  id: AUTOMATION_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  enabled: true,
  managedByAgentId: null,
};

const ORG_SCOPED_AUTH = { scope: 'organization', partnerId: PARTNER_ID };
const PARTNER_SCOPED_AUTH = { scope: 'partner', partnerId: PARTNER_ID };
const FOREIGN_PARTNER_AUTH = { scope: 'partner', partnerId: OTHER_PARTNER_ID };

/** Queue results for the successive `.select()` chains each call performs. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? []);
    return chain;
  });
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  enqueueAutomationRunMock.mockClear();
  insertMock.mockReturnValue({
    values: () => ({ returning: () => Promise.resolve([{ id: RUN_ID, logs: [] }]) }),
  });
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
});

describe('policy-evaluation remediation respects the caller partner axis (#4952)', () => {
  it('does not remediate with a partner-wide automation for an ORG-scoped caller', async () => {
    queueSelects(
      [{ partnerId: PARTNER_ID }],  // automationOwnershipConditionForOrg
      [PARTNER_WIDE_AUTOMATION],    // the automation an ungated query returns
    );

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Drift policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
      ORG_SCOPED_AUTH,
    );

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
  });

  it('does not remediate with a partner-wide automation of a DIFFERENT partner', async () => {
    queueSelects([{ partnerId: PARTNER_ID }], [PARTNER_WIDE_AUTOMATION]);

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Drift policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
      FOREIGN_PARTNER_AUTH,
    );

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('remediates for a PARTNER-scoped caller of the owning partner', async () => {
    queueSelects([{ partnerId: PARTNER_ID }], [PARTNER_WIDE_AUTOMATION]);

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Drift policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
      PARTNER_SCOPED_AUTH,
    );

    expect(result).toBe(RUN_ID);
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID, [DEVICE.id]);
  });

  it('remediates on the worker path, where no caller identity is supplied', async () => {
    queueSelects([{ partnerId: PARTNER_ID }], [PARTNER_WIDE_AUTOMATION]);

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Drift policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
    );

    expect(result).toBe(RUN_ID);
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID, [DEVICE.id]);
  });

  it('still remediates an ORG-scoped caller with an ORG-OWNED automation', async () => {
    queueSelects(
      [{ partnerId: PARTNER_ID }],
      [{ ...PARTNER_WIDE_AUTOMATION, orgId: ORG_ID, partnerId: null }],
    );

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Drift policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
      ORG_SCOPED_AUTH,
    );

    expect(result).toBe(RUN_ID);
  });
});

describe('script-based remediation resolution respects the caller partner axis (#4952)', () => {
  const policy = {
    id: 'policy-1',
    orgId: ORG_ID,
    partnerId: null,
    name: 'Drift policy',
    rules: [],
    remediationScriptId: SCRIPT_ID,
  };

  it('skips a partner-wide candidate automation for an ORG-scoped caller', async () => {
    queueSelects(
      [{ partnerId: PARTNER_ID }],
      [{ id: AUTOMATION_ID, actions: [{ scriptId: SCRIPT_ID }], orgId: null, partnerId: PARTNER_ID }],
    );

    const resolved = await resolvePolicyRemediationAutomationIdForOrg(
      policy as never,
      ORG_ID,
      ORG_SCOPED_AUTH,
    );

    expect(resolved).toBeNull();
  });

  it('resolves the same candidate for a PARTNER-scoped caller of that partner', async () => {
    queueSelects(
      [{ partnerId: PARTNER_ID }],
      [{ id: AUTOMATION_ID, actions: [{ scriptId: SCRIPT_ID }], orgId: null, partnerId: PARTNER_ID }],
    );

    const resolved = await resolvePolicyRemediationAutomationIdForOrg(
      policy as never,
      ORG_ID,
      PARTNER_SCOPED_AUTH,
    );

    expect(resolved).toBe(AUTOMATION_ID);
  });
});

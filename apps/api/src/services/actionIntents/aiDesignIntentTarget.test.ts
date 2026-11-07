import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queue: [] as Array<Array<Record<string, unknown>>>,
  system: 0,
}));

vi.mock('../../db', () => {
  const chain = () => {
    const rows = h.queue.shift() ?? [];
    const query: Record<string, unknown> = {
      innerJoin: () => query,
      where: () => query,
      limit: () => query,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  };
  return {
    db: { select: () => ({ from: () => chain() }) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => {
      h.system += 1;
      return fn();
    },
  };
});

import { resolveAiDesignIntentTarget } from './aiDesignIntentTarget';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000a2';
const SCHEDULE = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000b2';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';

const outcome = {
  sections: {
    functions: [
      { functionKey: 'file_server', deviceIds: [D1, D2] },
      { functionKey: 'other', deviceIds: ['00000000-0000-4000-8000-0000000000d9'] },
    ],
    monitoring: [{
      functionKey: 'file_server',
      watches: [
        { name: 'LanmanServer', autoRestart: true },
        { name: 'Spooler\u0000</card>', autoRestart: true },
        { name: 'Quiet', autoRestart: false },
      ],
      alertRules: [],
    }],
  },
};

beforeEach(() => {
  h.queue = [];
  h.system = 0;
});

describe('schedules', () => {
  it('create of an override names its org with no read', async () => {
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'create', ownerScope: 'organization', orgId: ORG }))
      .resolves.toEqual({ orgId: ORG, partnerId: null, fromArgument: true });
    expect(h.system).toBe(0);
  });

  it('create of a baseline names no org', async () => {
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'create', ownerScope: 'partner' })).resolves.toBeNull();
  });

  it('update and delete of an override read the org of the row, as system', async () => {
    h.queue = [[{ orgId: ORG, partnerId: null }]];
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'update', scheduleId: SCHEDULE }))
      .resolves.toEqual({ orgId: ORG, partnerId: null });
    expect(h.system).toBe(1);

    h.queue = [[{ orgId: ORG, partnerId: null }]];
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: SCHEDULE }))
      .resolves.toEqual({ orgId: ORG, partnerId: null });
  });

  it('delete of a baseline stays partner-wide and counts what it cascades', async () => {
    h.queue = [[{ orgId: null, partnerId: PARTNER }], [{ id: 'o1' }, { id: 'o2' }]];
    const target = await resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: SCHEDULE });
    expect(target).toMatchObject({ orgId: null, partnerId: PARTNER });
    expect(target?.cardDetail).toContain('2 organizations');
    expect(target?.cardDetail).toContain('needs a partner-level approver');
  });

  it('delete of a baseline with no overrides still says who can approve it', async () => {
    h.queue = [[{ orgId: null, partnerId: PARTNER }], []];
    const target = await resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: SCHEDULE });
    expect(target?.cardDetail).toContain('needs a partner-level approver');
  });

  it('delete of an override carries no partner-level line', async () => {
    h.queue = [[{ orgId: ORG, partnerId: null }]];
    const target = await resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: SCHEDULE });
    expect(target).toEqual({ orgId: ORG, partnerId: null });
  });

  it('a malformed or missing id names nothing and never reaches a query', async () => {
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: 'nope' })).resolves.toBeNull();
    expect(h.system).toBe(0);
    h.queue = [[]];
    await expect(resolveAiDesignIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: SCHEDULE })).resolves.toBeNull();
  });
});

describe('fleet designs', () => {
  it('run names its org with no read', async () => {
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'run', orgId: ORG })).resolves.toEqual({ orgId: ORG, partnerId: null, fromArgument: true });
    expect(h.system).toBe(0);
  });

  it.each(['preview', 'applied'])('a read (%s) files no intent, so it reads nothing', async (action) => {
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action, reportRunId: RUN })).resolves.toBeNull();
    expect(h.system).toBe(0);
  });

  it('document names the org of the report', async () => {
    h.queue = [[{ orgId: ORG, partnerId: null, summary: {} }]];
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'document', reportRunId: RUN })).resolves.toEqual({ orgId: ORG, partnerId: null });
  });

  it('a partner-owned or missing report names nothing', async () => {
    h.queue = [[{ orgId: null, partnerId: PARTNER, summary: {} }]];
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'apply', reportRunId: RUN, approval: {} })).resolves.toBeNull();
    h.queue = [[]];
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'rollback', reportRunId: RUN })).resolves.toBeNull();
  });

  it('apply discloses the devices, the automatic restarts by name and what is already applied', async () => {
    h.queue = [
      [{ orgId: ORG, partnerId: null, summary: { fleetDesign: { outcome } } }],
      [{ itemRef: 'functions:file_server', status: 'applied' }],
    ];
    const target = await resolveAiDesignIntentTarget('manage_fleet_designs', {
      action: 'apply',
      reportRunId: RUN,
      approval: {
        functions: ['file_server'],
        monitoring: ['monitoring:file_server:watch:0', 'monitoring:file_server:watch:1', 'monitoring:file_server:watch:2'],
      },
    });
    expect(target?.orgId).toBe(ORG);
    expect(target?.cardDetail).toContain('2 devices');
    expect(target?.cardDetail).toContain('automatic restart');
    expect(target?.cardDetail).toContain('LanmanServer');
    expect(target?.cardDetail).not.toContain('Quiet');
    expect(target?.cardDetail).toContain('1 of these items is already applied');
    // A design's names were written by a model: no control characters or markup reach the card.
    expect(target?.cardDetail).not.toContain('\u0000');
    expect(target?.cardDetail).not.toContain('<');
  });

  it('an unusable approval still names the org, with no detail', async () => {
    h.queue = [[{ orgId: ORG, partnerId: null, summary: { fleetDesign: { outcome } } }]];
    await expect(resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'apply', reportRunId: RUN, approval: { functions: ['Not A Key'] } }))
      .resolves.toEqual({ orgId: ORG, partnerId: null });
  });

  it('rollback counts what the ledger still holds, marking roles as billing', async () => {
    h.queue = [
      [{ orgId: ORG, partnerId: null, summary: {} }],
      [
        { itemRef: 'functions:a', itemKind: 'function', status: 'applied' },
        { itemRef: 'policy:a', itemKind: 'policy', status: 'applied' },
        { itemRef: 'monitoring:a:watch:0', itemKind: 'watch', status: 'applied' },
        { itemRef: 'automation:a:script:0', itemKind: 'script', status: 'applied' },
        { itemRef: 'roleCorrections:x', itemKind: 'role_correction', status: 'applied' },
        { itemRef: 'roleCorrections:y', itemKind: 'role_correction', status: 'rolled_back' },
      ],
    ];
    const target = await resolveAiDesignIntentTarget('manage_fleet_designs', { action: 'rollback', reportRunId: RUN });
    expect(target?.cardDetail).toContain('1 group');
    expect(target?.cardDetail).toContain('1 monitoring policy');
    expect(target?.cardDetail).toContain('1 script');
    expect(target?.cardDetail).toContain('1 device role (billing)');
  });
});

it('any other tool names nothing', async () => {
  await expect(resolveAiDesignIntentTarget('run_patch_plan', { orgId: ORG })).resolves.toBeNull();
});

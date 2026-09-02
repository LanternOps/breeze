import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  insertMock,
  insertValuesMock,
  publishEventMock,
  selectDistinctMock,
  selectMock,
  transactionMock,
  updateMock,
} = vi.hoisted(() => ({
  insertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  publishEventMock: vi.fn(),
  selectDistinctMock: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../db', () => {
  const tx = {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
    selectDistinct: selectDistinctMock,
  };
  transactionMock.mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx));
  return {
    db: { ...tx, transaction: transactionMock },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./eventBus', () => ({
  publishEvent: publishEventMock,
}));

import {
  __testOnly,
  createAutomationRunRecord,
  type AutomationTriggerContext,
} from './automationRuntime';

const AUTOMATION = {
  id: 'auto-1',
  orgId: 'org-1',
  partnerId: null,
  name: 'Alert triage',
  trigger: { type: 'event', eventType: 'alert.triggered' },
  actions: [{ type: 'ai_triage' }],
  conditions: null,
  onFailure: 'stop',
  notificationTargets: null,
  createdBy: 'user-1',
  managedByAgentId: 'agent-1',
} as any;

function mockInsertAndUpdate() {
  insertValuesMock.mockReturnValue({
    returning: vi.fn().mockResolvedValue([{
      id: 'run-1',
      automationId: 'auto-1',
      triggeredBy: 'event:alert.triggered',
      status: 'running',
    }]),
  });
  insertMock.mockReturnValue({ values: insertValuesMock });
  updateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
  publishEventMock.mockResolvedValue(undefined);
}

function mockAdmissionSelects() {
  selectMock
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }]),
        }),
      }),
    });
}

describe('createAutomationRunRecord event-target binding (#3824)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertAndUpdate();
    selectMock.mockReset();
    mockAdmissionSelects();
  });

  it('boundDeviceIds bypasses resolveAutomationTargetDeviceIds', async () => {
    const result = await createAutomationRunRecord({
      automation: AUTOMATION,
      triggeredBy: 'event:alert.triggered',
      boundDeviceIds: ['dev-1'],
    });

    expect(result.targetDeviceIds).toEqual(['dev-1']);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ devicesTargeted: 1 }));
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('without boundDeviceIds the configured target set is still resolved', async () => {
    selectMock.mockReset();
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: 'dev-1' },
          { id: 'dev-2' },
          { id: 'dev-3' },
        ]),
      }),
    });
    mockAdmissionSelects();

    const result = await createAutomationRunRecord({
      automation: AUTOMATION,
      triggeredBy: 'event:alert.triggered',
    });

    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(result.targetDeviceIds).toEqual(['dev-1', 'dev-2', 'dev-3']);
  });
});

describe('buildActionExecutionContext event context (#3824)', () => {
  const trigger: AutomationTriggerContext = {
    alertId: 'alert-1',
    eventId: 'evt-1',
    severity: 'high',
    ruleId: 'rule-1',
  };

  const base = {
    automation: {
      id: 'auto-1',
      orgId: 'org-1',
      name: 'Alert triage',
      createdBy: 'user-1',
      managedByAgentId: 'agent-1',
    },
    runId: 'run-1',
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: { orgIds: new Set(['org-1']) },
    trigger,
  } as any;

  const device = (id: string) => ({
    id,
    orgId: 'org-1',
    hostname: `${id}.example`,
    displayName: null,
    osType: 'linux' as const,
    status: 'online' as const,
    agentId: `agent-${id}`,
    siteId: 'site-1',
    customFields: {},
  });

  it('copies the run trigger onto every device context', () => {
    const first = __testOnly.buildActionExecutionContext(base, device('dev-1'));
    const second = __testOnly.buildActionExecutionContext(base, device('dev-2'));

    expect(first.trigger).toBe(trigger);
    expect(second.trigger).toBe(trigger);
    expect(first.device.id).toBe('dev-1');
    expect(second.device.id).toBe('dev-2');
  });

  it('leaves trigger undefined for unbound runs', () => {
    // `trigger` is a REQUIRED-but-undefined property of the builder input on
    // purpose — dropping it at the call site must not compile.
    const unboundBase = { ...base, trigger: undefined };

    const context = __testOnly.buildActionExecutionContext(unboundBase, device('dev-1'));

    expect(context.trigger).toBeUndefined();
  });
});

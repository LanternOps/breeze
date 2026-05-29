import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB and the schema so we can drive createSession / listM365Connections
// through the real service logic without a live database.
const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {},
  delegantM365Connections: {
    id: 'delegantM365Connections.id',
    orgId: 'delegantM365Connections.orgId',
    customerLabel: 'delegantM365Connections.customerLabel',
    customerDisplayName: 'delegantM365Connections.customerDisplayName',
    status: 'delegantM365Connections.status',
  },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base' }));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn().mockResolvedValue(null),
}));

import { createSession, listM365Connections } from './aiAgent';

const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';

function connSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

const auth: any = {
  user: { id: 'user-1' },
  orgId: 'org-111',
  accessibleOrgIds: ['org-111'],
  canAccessOrg: (id: string) => id === 'org-111',
  orgCondition: () => undefined,
};

describe('createSession M365 binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a connection belonging to a different org', async () => {
    selectMock.mockReturnValueOnce(
      connSelect([{ id: CONNECTION_ID, orgId: 'org-OTHER', status: 'active' }])
    );

    await expect(
      createSession(auth, { delegantM365ConnectionId: CONNECTION_ID })
    ).rejects.toThrow('Invalid M365 connection');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown connection', async () => {
    selectMock.mockReturnValueOnce(connSelect([]));

    await expect(
      createSession(auth, { delegantM365ConnectionId: CONNECTION_ID })
    ).rejects.toThrow('Invalid M365 connection');
  });

  it('rejects a non-active connection', async () => {
    selectMock.mockReturnValueOnce(
      connSelect([{ id: CONNECTION_ID, orgId: 'org-111', status: 'revoked' }])
    );

    await expect(
      createSession(auth, { delegantM365ConnectionId: CONNECTION_ID })
    ).rejects.toThrow('Invalid M365 connection');
  });

  it('persists delegantM365ConnectionId for a valid same-org connection', async () => {
    selectMock.mockReturnValueOnce(
      connSelect([{ id: CONNECTION_ID, orgId: 'org-111', status: 'active' }])
    );
    const valuesSpy = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]),
    });
    insertMock.mockReturnValueOnce({ values: valuesSpy });

    const result = await createSession(auth, { delegantM365ConnectionId: CONNECTION_ID });

    expect(result.delegantM365ConnectionId).toBe(CONNECTION_ID);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ delegantM365ConnectionId: CONNECTION_ID })
    );
  });

  it('persists a null connection id when none is supplied (back-compat)', async () => {
    const valuesSpy = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]),
    });
    insertMock.mockReturnValueOnce({ values: valuesSpy });

    const result = await createSession(auth, {});

    expect(result.delegantM365ConnectionId).toBeNull();
    // no connection lookup performed
    expect(selectMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ delegantM365ConnectionId: null })
    );
  });
});

describe('listM365Connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects only the three safe columns filtered to active connections', async () => {
    const selectArgsHolder: any = {};
    const whereSpy = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockResolvedValue([
        { id: CONNECTION_ID, customerLabel: 'acme', customerDisplayName: 'Acme Corp' },
      ]),
    });
    selectMock.mockImplementationOnce((cols: any) => {
      selectArgsHolder.cols = cols;
      return { from: vi.fn().mockReturnValue({ where: whereSpy }) };
    });

    const rows = await listM365Connections(auth);

    expect(rows).toEqual([
      { id: CONNECTION_ID, customerLabel: 'acme', customerDisplayName: 'Acme Corp' },
    ]);
    // projection must NOT include any pointer/tenant fields
    expect(Object.keys(selectArgsHolder.cols)).toEqual([
      'id',
      'customerLabel',
      'customerDisplayName',
    ]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks } = vi.hoisted(() => {
  const selectResult = vi.fn();
  return { dbMocks: { selectResult } };
});

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbMocks.selectResult())
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  ticketStatuses: {
    id: 'id',
    partnerId: 'partnerId',
    coreStatus: 'coreStatus',
    isSystem: 'isSystem',
    name: 'name',
    isActive: 'isActive',
  },
  ticketPrioritySettings: {
    partnerId: 'partnerId',
    priority: 'priority',
    responseSlaMinutes: 'responseSlaMinutes',
    resolutionSlaMinutes: 'resolutionSlaMinutes',
  },
  orgTicketSettings: {
    orgId: 'orgId',
    slaOverrides: 'slaOverrides',
  },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketPriorityEnum: { enumValues: ['low', 'normal', 'high', 'urgent'] },
}));

import {
  getOrgSlaOverride,
  getPartnerPrioritySla,
  getSystemStatusId,
} from './ticketConfigService';

describe('getOrgSlaOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResult.mockClear();
  });

  it('returns response/resolution minutes for a valid org override', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      slaOverrides: { urgent: { responseMinutes: 120, resolutionMinutes: 480 } }
    }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: 120, resolutionMinutes: 480 });
  });

  it('returns nulls when the org row is missing', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    const result = await getOrgSlaOverride('o-missing', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('returns nulls when slaOverrides is a string (malformed jsonb)', async () => {
    dbMocks.selectResult.mockResolvedValue([{ slaOverrides: 'garbage' }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('returns nulls when priority key is missing', async () => {
    dbMocks.selectResult.mockResolvedValue([{ slaOverrides: { high: { responseMinutes: 60, resolutionMinutes: 240 } } }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('returns nulls when responseMinutes is a string (malformed value)', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      slaOverrides: { urgent: { responseMinutes: 'x', resolutionMinutes: 240 } }
    }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: 240 });
  });

  it('returns nulls for float minutes (rejects non-integer)', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      slaOverrides: { urgent: { responseMinutes: 60.5, resolutionMinutes: 240 } }
    }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: 240 });
  });

  it('returns null for negative minutes in sla_overrides', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      slaOverrides: { urgent: { responseMinutes: -30, resolutionMinutes: 240 } }
    }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: 240 });
  });

  it('returns nulls when slaOverrides is null', async () => {
    dbMocks.selectResult.mockResolvedValue([{ slaOverrides: null }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('returns nulls when priority tier value is not an object', async () => {
    dbMocks.selectResult.mockResolvedValue([{ slaOverrides: { urgent: 5 } }]);
    const result = await getOrgSlaOverride('o-1', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});

describe('getPartnerPrioritySla', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResult.mockClear();
  });

  it('returns response/resolution minutes from a priority settings row', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      responseSlaMinutes: 90,
      resolutionSlaMinutes: 360,
    }]);
    const result = await getPartnerPrioritySla('p-1', 'high');
    expect(result).toEqual({ responseMinutes: 90, resolutionMinutes: 360 });
  });

  it('returns nulls when no row exists for the partner/priority', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    const result = await getPartnerPrioritySla('p-missing', 'urgent');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('returns nulls when the row has null SLA columns', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      responseSlaMinutes: null,
      resolutionSlaMinutes: null,
    }]);
    const result = await getPartnerPrioritySla('p-1', 'normal');
    expect(result).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});

describe('getSystemStatusId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResult.mockClear();
  });

  it('returns the status uuid when found', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'status-uuid-123' }]);
    const result = await getSystemStatusId('p-1', 'open');
    expect(result).toBe('status-uuid-123');
  });

  it('returns null when no system status row exists', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    const result = await getSystemStatusId('p-1', 'new');
    expect(result).toBeNull();
  });
});

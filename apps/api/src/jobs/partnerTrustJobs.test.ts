import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update, select, runOutside, withSystem, classify, tryAutoPromote } = vi.hoisted(() => ({
  update: vi.fn(),
  select: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classify: vi.fn(),
  tryAutoPromote: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update, select },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: { id: 'partners.id', trustState: 'partners.trustState' },
  devices: { id: 'devices.id' },
}));
vi.mock('../services/ipClassify', () => ({
  classifyIp: classify,
}));
vi.mock('../services/partnerTrustPromotion', () => ({ tryAutoPromote }));

import { processPartnerTrustJob } from './partnerTrustJobs';

describe('processPartnerTrustJob', () => {
  const set = vi.fn();
  const where = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'shadow';
    classify.mockResolvedValue({ ipClass: 'hosting', asn: 64500, provider: 'ipinfo' });
    tryAutoPromote.mockResolvedValue(false);
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
  });

  it('iterates probation partners in batches and attempts promotion for each', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ id: `partner-${String(i).padStart(3, '0')}` }));
    const second = [{ id: 'partner-200' }];
    const limit = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const orderBy = vi.fn(() => ({ limit }));
    const selectWhere = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where: selectWhere }));
    select.mockReturnValue({ from });
    tryAutoPromote.mockImplementation(async (id: string) => id === 'partner-200');

    await expect(processPartnerTrustJob({ name: 'partner-trust-promote', data: {} }))
      .resolves.toEqual({ processed: 201, promoted: 1 });

    expect(tryAutoPromote).toHaveBeenCalledTimes(201);
    expect(tryAutoPromote).toHaveBeenLastCalledWith('partner-200');
    expect(limit).toHaveBeenCalledTimes(2);
    expect(runOutside).toHaveBeenCalledTimes(2);
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  it('writes partner signup classification in a system DB context', async () => {
    await processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'partner', partnerId: 'partner-1', ip: '198.51.100.1' },
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      signupIpClass: 'hosting', signupIpAsn: 64500, signupIpClassifiedAt: expect.any(Date),
    }));
    expect(runOutside).toHaveBeenCalledTimes(1);
    expect(withSystem).toHaveBeenCalledTimes(1);
  });

  it('writes device enrollment classification', async () => {
    await processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'device', deviceId: 'device-1', ip: '198.51.100.2' },
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      enrollmentIpClass: 'hosting', enrollmentIpAsn: 64500, enrollmentIpClassifiedAt: expect.any(Date),
    }));
  });

  it('does nothing when partner trust is off', async () => {
    process.env.PARTNER_TRUST_MODE = 'off';
    await processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'partner', partnerId: 'partner-1', ip: '198.51.100.1' },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  update, select, runOutside, withSystem, classify, tryAutoPromote,
  evaluateHardDenies, setTrustState, partnerForDevice,
} = vi.hoisted(() => ({
  update: vi.fn(),
  select: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classify: vi.fn(),
  tryAutoPromote: vi.fn(),
  evaluateHardDenies: vi.fn(),
  setTrustState: vi.fn(),
  partnerForDevice: vi.fn(),
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
vi.mock('../services/partnerTrustPromotion', () => ({ tryAutoPromote, evaluateHardDenies }));
vi.mock('../services/partnerTrust', () => ({ setTrustState }));
vi.mock('../services/partnerTrust.repo', () => ({ partnerForDevice }));

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
    evaluateHardDenies.mockResolvedValue({ restrict: false });
    setTrustState.mockResolvedValue(true);
    partnerForDevice.mockResolvedValue('partner-for-device');
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
    expect(evaluateHardDenies).toHaveBeenCalledTimes(201);
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
    expect(evaluateHardDenies).toHaveBeenCalledWith('partner-1');
  });

  it('writes device enrollment classification', async () => {
    await processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'device', deviceId: 'device-1', ip: '198.51.100.2' },
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      enrollmentIpClass: 'hosting', enrollmentIpAsn: 64500, enrollmentIpClassifiedAt: expect.any(Date),
    }));
    expect(partnerForDevice).toHaveBeenCalledWith('device-1');
    expect(evaluateHardDenies).toHaveBeenCalledWith('partner-for-device');
  });

  it('restricts a probation partner on hard deny and does not attempt promotion', async () => {
    const limit = vi.fn().mockResolvedValue([{ id: 'partner-1' }]);
    select.mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
    });
    evaluateHardDenies.mockResolvedValue({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'] },
    });

    await expect(processPartnerTrustJob({ name: 'partner-trust-promote', data: {} }))
      .resolves.toEqual({ processed: 1, promoted: 0 });

    expect(setTrustState).toHaveBeenCalledWith(
      'partner-1', 'restricted', 'auto:tor_signup', null,
      { matchedAxes: ['signup_ip_class'] },
      { expectedFrom: 'probation' },
    );
    expect(tryAutoPromote).not.toHaveBeenCalled();
  });

  it('does not restrict when the probation CAS loses to a trusted state', async () => {
    evaluateHardDenies.mockResolvedValue({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: {},
    });
    setTrustState.mockResolvedValue(false);

    await processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'partner', partnerId: 'partner-1', ip: '198.51.100.1' },
    });

    expect(setTrustState).toHaveBeenCalledWith(
      'partner-1', 'restricted', 'auto:tor_signup', null, {},
      { expectedFrom: 'probation' },
    );
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

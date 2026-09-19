import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  update, select, runOutside, withSystem, classify, tryAutoPromote,
  restrictOnHardDeny, partnerForDevice, ipClassifyProvider,
} = vi.hoisted(() => ({
  update: vi.fn(),
  select: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classify: vi.fn(),
  tryAutoPromote: vi.fn(),
  restrictOnHardDeny: vi.fn(),
  partnerForDevice: vi.fn(),
  ipClassifyProvider: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update, select },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: {
    id: 'partners.id',
    trustState: 'partners.trustState',
    signupIp: 'partners.signupIp',
    signupIpClass: 'partners.signupIpClass',
    signupIpClassifiedAt: 'partners.signupIpClassifiedAt',
  },
  devices: { id: 'devices.id' },
}));
vi.mock('../services/ipClassify', () => ({ classifyIp: classify }));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env')>()),
  ipClassifyProvider,
}));
vi.mock('../services/partnerTrustPromotion', () => ({ tryAutoPromote, restrictOnHardDeny }));
vi.mock('../services/partnerTrust.repo', () => ({ partnerForDevice }));

import { processPartnerTrustJob } from './partnerTrustJobs';

type ProbationRow = {
  id: string;
  signupIp: string | null;
  signupIpClass: string;
  signupIpClassifiedAt: Date | null;
};

const probationRow = (overrides: Partial<ProbationRow> = {}): ProbationRow => ({
  id: 'partner-1',
  signupIp: '198.51.100.7',
  signupIpClass: 'unknown',
  signupIpClassifiedAt: null,
  ...overrides,
});

describe('processPartnerTrustJob', () => {
  const set = vi.fn();
  const where = vi.fn(async () => undefined);

  const withBatch = (...batches: ProbationRow[][]) => {
    const limit = vi.fn();
    for (const batch of batches) limit.mockResolvedValueOnce(batch);
    limit.mockResolvedValue([]);
    select.mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
    });
    return limit;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'shadow';
    classify.mockResolvedValue({ ipClass: 'hosting', asn: 64500, provider: 'ipinfo' });
    tryAutoPromote.mockResolvedValue(false);
    restrictOnHardDeny.mockResolvedValue(false);
    partnerForDevice.mockResolvedValue('partner-for-device');
    ipClassifyProvider.mockReturnValue('none');
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
  });

  it('iterates probation partners in batches and attempts promotion for each', async () => {
    const first = Array.from({ length: 200 }, (_, i) => probationRow({ id: `partner-${String(i).padStart(3, '0')}` }));
    const second = [probationRow({ id: 'partner-200' })];
    const limit = withBatch(first, second);
    tryAutoPromote.mockImplementation(async (id: string) => id === 'partner-200');

    await expect(processPartnerTrustJob({ name: 'partner-trust-promote', data: {} }))
      .resolves.toEqual({ processed: 201, promoted: 1 });

    expect(tryAutoPromote).toHaveBeenCalledTimes(201);
    expect(tryAutoPromote).toHaveBeenLastCalledWith('partner-200');
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it('skips a partner whose promotion evaluation throws, without stopping the batch', async () => {
    withBatch([probationRow({ id: 'partner-1' }), probationRow({ id: 'partner-2' })]);
    tryAutoPromote.mockImplementation(async (id: string) => {
      if (id === 'partner-1') throw new Error('db exploded');
      return true;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(processPartnerTrustJob({ name: 'partner-trust-promote', data: {} }))
      .resolves.toEqual({ processed: 2, promoted: 1 });

    expect(tryAutoPromote).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('partner-1'), expect.any(Error));
    warnSpy.mockRestore();
  });

  it('never evaluates hard denies twice — tryAutoPromote owns that call now', async () => {
    withBatch([probationRow()]);

    await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

    expect(restrictOnHardDeny).not.toHaveBeenCalled();
  });

  describe('signup-IP backfill', () => {
    it('classifies and persists an unclassified signup IP before promotion is attempted', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow({ id: 'partner-1', signupIp: '198.51.100.7' })]);
      const order: string[] = [];
      classify.mockImplementation(async () => {
        order.push('classify');
        return { ipClass: 'residential', asn: 64500, provider: 'ipinfo' };
      });
      tryAutoPromote.mockImplementation(async () => {
        order.push('promote');
        return false;
      });

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).toHaveBeenCalledWith('198.51.100.7');
      expect(set).toHaveBeenCalledWith({
        signupIpClass: 'residential',
        signupIpAsn: 64500,
        signupIpClassifiedAt: expect.any(Date),
      });
      expect(order).toEqual(['classify', 'promote']);
    });

    it('persists the unknown result so a provider outage does not retry every run', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow()]);
      classify.mockResolvedValue({ ipClass: 'unknown', asn: null, provider: 'ipinfo' });

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(set).toHaveBeenCalledWith({
        signupIpClass: 'unknown',
        signupIpAsn: null,
        signupIpClassifiedAt: expect.any(Date),
      });
    });

    it('does not classify when no provider is configured', async () => {
      ipClassifyProvider.mockReturnValue('none');
      withBatch([probationRow()]);

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('does not classify a partner with no signup IP recorded', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow({ signupIp: null })]);

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).not.toHaveBeenCalled();
      expect(tryAutoPromote).toHaveBeenCalledWith('partner-1');
    });

    it('does not re-classify a partner that already has a class', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow({ signupIpClass: 'residential' })]);

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).not.toHaveBeenCalled();
    });

    it('skips a retry attempted within the last hour', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow({ signupIpClassifiedAt: new Date(Date.now() - 30 * 60 * 1_000) })]);

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).not.toHaveBeenCalled();
    });

    it('retries once the previous attempt is older than an hour', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow({ signupIpClassifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000) })]);

      await processPartnerTrustJob({ name: 'partner-trust-promote', data: {} });

      expect(classify).toHaveBeenCalledWith('198.51.100.7');
    });

    it('still attempts promotion when the backfill lookup throws', async () => {
      ipClassifyProvider.mockReturnValue('ipinfo');
      withBatch([probationRow()]);
      classify.mockRejectedValue(new Error('provider exploded'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(processPartnerTrustJob({ name: 'partner-trust-promote', data: {} }))
        .resolves.toEqual({ processed: 1, promoted: 0 });

      expect(tryAutoPromote).toHaveBeenCalledWith('partner-1');
      warnSpy.mockRestore();
    });
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
    expect(restrictOnHardDeny).toHaveBeenCalledWith('partner-1');
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
    expect(restrictOnHardDeny).toHaveBeenCalledWith('partner-for-device');
  });

  it('does not throw out of the ip-classify job when hard-deny evaluation fails', async () => {
    restrictOnHardDeny.mockRejectedValue(new Error('db exploded'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(processPartnerTrustJob({
      name: 'ip-classify',
      data: { kind: 'partner', partnerId: 'partner-1', ip: '198.51.100.1' },
    })).resolves.toEqual({ ipClass: 'hosting', asn: 64500, provider: 'ipinfo' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('partner-1'), expect.any(Error));
    warnSpy.mockRestore();
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update, runOutside, withSystem, classify } = vi.hoisted(() => ({
  update: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  classify: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: { id: 'partners.id' },
  devices: { id: 'devices.id' },
}));
vi.mock('../services/ipClassify', () => ({
  classifyIp: classify,
}));

import { processPartnerTrustJob } from './partnerTrustJobs';

describe('processPartnerTrustJob', () => {
  const set = vi.fn();
  const where = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'shadow';
    classify.mockResolvedValue({ ipClass: 'hosting', asn: 64500, provider: 'ipinfo' });
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
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

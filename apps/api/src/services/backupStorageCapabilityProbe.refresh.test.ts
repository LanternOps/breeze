import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  probe: vi.fn(),
  record: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update: () => ({ set: () => ({ where: m.update }) }) },
  runAfterDbContextExit: vi.fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({ backupConfigs: { id: 'id', providerCapabilities: 'provider_capabilities' } }));
vi.mock('./backupProviderConfig', () => ({ resolveBackupProviderConfig: m.resolve }));
vi.mock('./backupStoragePresign', () => ({ probeConditionalWrites: m.probe }));
vi.mock('./backupMetrics', () => ({ recordConditionalWriteProbe: m.record }));

import { refreshConditionalWriteProbe } from './backupStorageCapabilityProbe';

const S3 = { provider: 's3', providerConfig: { bucket: 'b', region: 'us-east-1', endpoint: 'https://storage.example' } };

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockResolvedValue(S3);
});

describe('refreshConditionalWriteProbe', () => {
  it('counts each probe by outcome and reason, and records unsupported on failure', async () => {
    m.probe.mockResolvedValueOnce({ supported: false, reason: 'probe_write_failed' });
    await expect(refreshConditionalWriteProbe('cfg', 'org')).resolves.toBe(false);
    expect(m.record).toHaveBeenCalledWith('unsupported', 'probe_write_failed');
    expect(m.update).toHaveBeenCalledTimes(1);

    m.probe.mockResolvedValueOnce({ supported: true, reason: 'precondition_enforced' });
    await expect(refreshConditionalWriteProbe('cfg', 'org')).resolves.toBe(true);
    expect(m.record).toHaveBeenCalledWith('supported', 'precondition_enforced');
  });

  // #7081: the probe answers for where new snapshots are written. A stored
  // prefix that does not normalize names no such place (mint refuses the
  // destination), and a result recorded for it would outlive the fix: the
  // record is keyed by storage identity, which excludes the prefix.
  it('skips a destination whose stored prefix is invalid: no probe, nothing recorded', async () => {
    m.resolve.mockResolvedValue({ ...S3, providerConfig: { ...S3.providerConfig, prefix: 'a//b' } });
    await expect(refreshConditionalWriteProbe('cfg', 'org')).resolves.toBeNull();
    expect(m.probe).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});

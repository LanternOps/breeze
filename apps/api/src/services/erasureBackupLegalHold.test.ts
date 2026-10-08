import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Device-scoped policy legal hold check (#7982). The org-scoped form is
 * exercised end-to-end by backupErasureFence.integration.test.ts; these pin
 * how the SAME function narrows to one device for device purge.
 */
const { execute, resolveBackupProtectionForDevice } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveBackupProtectionForDevice: vi.fn(),
}));

vi.mock('../db', () => ({ db: { execute } }));
vi.mock('./featureConfigResolver', () => ({ resolveBackupProtectionForDevice }));

import { findPolicyBackupLegalHoldInContext } from './erasureBackupLegalHold';

const ORG = '22222222-2222-4222-8222-222222222222';
const DEV = '11111111-1111-4111-8111-111111111111';
const OTHER_DEV = '55555555-5555-4555-8555-555555555555';

interface Script {
  backupPolicyHold?: boolean;
  configCandidate?: boolean;
}

function scriptDb(script: Script): string[] {
  const statements: string[] = [];
  execute.mockImplementation(async (q: unknown) => {
    const text = JSON.stringify(q);
    statements.push(text);
    if (text.includes('FROM organizations')) return [{ partner_id: 'partner-1' }];
    if (text.includes('FROM backup_policies')) return script.backupPolicyHold ? [{ id: 'bp-1' }] : [];
    if (text.includes('config_policy_effective_feature_links')) return script.configCandidate ? [{ id: 'fl-1' }] : [];
    if (text.includes('FROM devices')) return [{ id: DEV }, { id: OTHER_DEV }];
    return [];
  });
  return statements;
}

describe('findPolicyBackupLegalHoldInContext — device scope', () => {
  beforeEach(() => {
    execute.mockReset();
    resolveBackupProtectionForDevice.mockReset();
    resolveBackupProtectionForDevice.mockResolvedValue(null);
  });

  it('narrows the backup_policy hold to policies the device\'s own backup jobs ran under', async () => {
    const statements = scriptDb({ backupPolicyHold: true });
    await expect(findPolicyBackupLegalHoldInContext(ORG, { deviceId: DEV })).resolves.toBe('backup_policy');
    const policyQuery = statements.find((s) => s.includes('FROM backup_policies') && s.includes('legal_hold = true'));
    expect(policyQuery).toBeDefined();
    expect(policyQuery).toContain('backup_jobs');
    expect(policyQuery).toContain(DEV);
  });

  it('resolves the configuration-policy hold for THIS device only, never the org\'s other devices', async () => {
    const statements = scriptDb({ configCandidate: true });
    resolveBackupProtectionForDevice.mockImplementation(async (id: string) =>
      id === OTHER_DEV ? { legalHold: true } : { legalHold: false });

    // Another device in the org being held must not block this device's purge.
    await expect(findPolicyBackupLegalHoldInContext(ORG, { deviceId: DEV })).resolves.toBeNull();
    expect(resolveBackupProtectionForDevice).toHaveBeenCalledTimes(1);
    expect(resolveBackupProtectionForDevice).toHaveBeenCalledWith(DEV);
    expect(statements.some((s) => s.includes('FROM devices'))).toBe(false);
  });

  it('reports a configuration-policy hold that is effective for the device', async () => {
    scriptDb({ configCandidate: true });
    resolveBackupProtectionForDevice.mockResolvedValue({ legalHold: true });
    await expect(findPolicyBackupLegalHoldInContext(ORG, { deviceId: DEV })).resolves.toBe('configuration_policy');
  });

  it('org scope (erasure) is unchanged: any held org policy, every org device resolved', async () => {
    const statements = scriptDb({ configCandidate: true });
    await expect(findPolicyBackupLegalHoldInContext(ORG)).resolves.toBeNull();
    const policyQuery = statements.find((s) => s.includes('FROM backup_policies') && s.includes('legal_hold = true'));
    expect(policyQuery).not.toContain('backup_jobs');
    expect(resolveBackupProtectionForDevice).toHaveBeenCalledTimes(2);
  });
});

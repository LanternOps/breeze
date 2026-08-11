import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { getOrgSettings, DEFAULT_DLP_CONFIG } from './orgSettingsService';

/** drizzle-stub pattern (mirrors credentialService.test.ts): select(...).from(...).where(...) resolves rows. */
function fakeDbReturning(rows: Record<string, unknown>[]) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
    })),
  };
  return db as unknown as WorkspaceDatabase;
}

describe('orgSettingsService', () => {
  it('defaults to disabled + default DLP config when no row exists', async () => {
    const db = fakeDbReturning([]); // helper: select(...).from(...).where(...) resolves []
    const s = await getOrgSettings(db, 'org-1');
    expect(s.contentEnabled).toBe(false);
    expect(s.dlpConfig).toEqual(DEFAULT_DLP_CONFIG);
  });

  it('collapses unknown detector actions to the safe default (default-deny)', async () => {
    const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
      dlpConfig: { detectors: { credit_card: 'shout', ssn: 'redact' } } }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.detectors.credit_card).toBe('redact'); // unknown → detector's default
    expect(s.dlpConfig.detectors.ssn).toBe('redact');
  });

  it('returns an independent dlpConfig object when no row exists, not the shared module-level singleton', async () => {
    const db = fakeDbReturning([]);
    const s = await getOrgSettings(db, 'org-1');
    // Reference identity, not just deep equality: a caller mutating the
    // returned dlpConfig in place must never corrupt DEFAULT_DLP_CONFIG for
    // every other org that later hits the same no-row branch.
    expect(s.dlpConfig).not.toBe(DEFAULT_DLP_CONFIG);
    expect(s.dlpConfig.detectors).not.toBe(DEFAULT_DLP_CONFIG.detectors);
  });

  it('DEFAULT_DLP_CONFIG is frozen (including nested detectors) as a defensive backstop', () => {
    expect(Object.isFrozen(DEFAULT_DLP_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DLP_CONFIG.detectors)).toBe(true);
  });
});

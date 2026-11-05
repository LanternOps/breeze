import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  clearTenantInstallerMaterial,
  INSTALLER_EXPIRY_MARGIN_MS,
  INSTALLER_FETCH_MAX_PER_RUN,
  INSTALLER_REFRESH_MAX_AGE_MS,
  installerRefreshDue,
  openInstallerMaterial,
  persistInstallerOutcomes,
  pickInstallerFetches,
  sealInstallerMaterial,
  type InstallerMaterialEnvelope,
} from './installerMaterial';
import { encryptEdrSecret } from './credentials';

// v1 ciphertext ignores AAD, so APP_ENCRYPTION_KEY_ID must be set for the
// wrong-tenant assertion to fail for the right reason (credentials.test.ts).
const originalEnv = {
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  APP_ENCRYPTION_KEY_ID: process.env.APP_ENCRYPTION_KEY_ID,
  APP_ENCRYPTION_KEYRING: process.env.APP_ENCRYPTION_KEYRING,
};
process.env.APP_ENCRYPTION_KEY = 'edr-installer-material-unit-test-key-material';
process.env.APP_ENCRYPTION_KEY_ID = 'edr-installer-material-test';
delete process.env.APP_ENCRYPTION_KEYRING;

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const envelope: InstallerMaterialEnvelope = {
  v: 1,
  provider: 'bitdefender',
  fetchedAt: NOW.toISOString(),
  expiresAt: null,
  data: { v: 1, packageName: 'Synthetic package', windowsUrl: 'https://download.example.test/setup.exe' },
};

describe('seal / open', () => {
  it('round-trips an envelope', () => {
    expect(openInstallerMaterial(TENANT_A, sealInstallerMaterial(TENANT_A, envelope))).toEqual(envelope);
  });

  it('a blob sealed for one tenant does not open for another (row-bound AAD)', () => {
    expect(openInstallerMaterial(TENANT_B, sealInstallerMaterial(TENANT_A, envelope))).toBeNull();
  });

  it.each([
    ['a newer envelope version', { ...envelope, v: 2 }],
    ['an unknown key', { ...envelope, extra: true }],
    ['a bad timestamp', { ...envelope, fetchedAt: 'yesterday' }],
    ['no data key', { v: 1, provider: 'bitdefender', fetchedAt: NOW.toISOString(), expiresAt: null }],
  ])('%s does not open', (_label, value) => {
    expect(openInstallerMaterial(TENANT_A, encryptEdrSecret('tenant_installer_secret', TENANT_A, value))).toBeNull();
  });

  it('never throws on garbage', () => {
    for (const garbage of ['', 'not-a-ciphertext', 'enc:v1:zzz']) {
      expect(openInstallerMaterial(TENANT_A, garbage)).toBeNull();
    }
  });
});

describe('installerRefreshDue', () => {
  const HOUR = 60 * 60 * 1000;
  const row = (over: Partial<Parameters<typeof installerRefreshDue>[0]> = {}) => ({
    orgId: 'org', hasMaterial: true, fetchedAt: new Date(NOW.getTime() - HOUR), expiresAt: null, fetchError: null, ...over,
  });

  it.each([
    ['an unmapped tenant, even with nothing stored', row({ orgId: null, hasMaterial: false, fetchedAt: null }), false],
    ['an unmapped tenant with an old error', row({ orgId: null, fetchError: 'vendor_error' }), false],
    ['no material yet', row({ hasMaterial: false, fetchedAt: null }), true],
    ['fresh material', row(), false],
    ['23 h old', row({ fetchedAt: new Date(NOW.getTime() - 23 * HOUR) }), false],
    ['25 h old', row({ fetchedAt: new Date(NOW.getTime() - 25 * HOUR) }), true],
    ['material with no fetch time', row({ fetchedAt: null }), true],
    ['expiry inside the margin', row({ expiresAt: new Date(NOW.getTime() + INSTALLER_EXPIRY_MARGIN_MS - HOUR) }), true],
    ['expiry outside the margin', row({ expiresAt: new Date(NOW.getTime() + INSTALLER_EXPIRY_MARGIN_MS + HOUR) }), false],
    ['the last attempt errored', row({ fetchError: 'no_package' }), true],
  ])('%s', (_label, input, due) => {
    expect(installerRefreshDue(input, NOW)).toBe(due);
  });

  it('refreshes daily and treats a day as the expiry margin', () => {
    expect(INSTALLER_REFRESH_MAX_AGE_MS).toBe(24 * HOUR);
    expect(INSTALLER_EXPIRY_MARGIN_MS).toBe(24 * HOUR);
  });
});

describe('pickInstallerFetches', () => {
  const due = Array.from({ length: INSTALLER_FETCH_MAX_PER_RUN + 10 }, (_, i) => i);

  it('returns everything when under the cap', () => {
    expect(pickInstallerFetches([1, 2, 3]).sort()).toEqual([1, 2, 3]);
  });

  it('caps a backlog, with no duplicates and nothing invented', () => {
    const picked = pickInstallerFetches(due);
    expect(picked).toHaveLength(INSTALLER_FETCH_MAX_PER_RUN);
    expect(new Set(picked).size).toBe(INSTALLER_FETCH_MAX_PER_RUN);
    expect(picked.every((n) => due.includes(n))).toBe(true);
  });

  it('reaches the tail of the list, so a stuck head cannot starve it', () => {
    const tail = due.slice(INSTALLER_FETCH_MAX_PER_RUN);
    expect(pickInstallerFetches(due, () => 0).some((n) => tail.includes(n))).toBe(true);
  });
});

/** Records each update: what was set and how many tenants it was aimed at. */
function fakeTx(returning: Array<{ id: string }> = []) {
  const sets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => {
      sets.push(values);
      return { where: () => Object.assign(Promise.resolve(), { returning: async () => returning }) };
    },
  }));
  return { tx: { update } as never, sets, update };
}

describe('persistInstallerOutcomes', () => {
  it('success seals the data and clears the error', async () => {
    const { tx, sets } = fakeTx();
    const expiresAt = new Date(NOW.getTime() + 10 * INSTALLER_EXPIRY_MARGIN_MS);
    await persistInstallerOutcomes(tx, 'bitdefender', [{ tenantId: TENANT_A, ok: true, data: envelope.data, expiresAt }], NOW);
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    expect(set).toMatchObject({ installerFetchedAt: NOW, installerExpiresAt: expiresAt, installerFetchError: null, updatedAt: NOW });
    expect(JSON.stringify(set)).not.toContain('download.example.test');
    expect(openInstallerMaterial(TENANT_A, set.installerSecretEncrypted as string)).toEqual({
      v: 1, provider: 'bitdefender', fetchedAt: NOW.toISOString(), expiresAt: expiresAt.toISOString(), data: envelope.data,
    });
  });

  it.each(['vendor_error'] as const)(
    'no answer from the vendor (%s) records the code and keeps a link that may still work',
    async (code) => {
      const { tx, sets } = fakeTx();
      await persistInstallerOutcomes(tx, 'bitdefender', [{ tenantId: TENANT_A, ok: false, code }], NOW);
      expect(sets).toEqual([{ installerFetchError: code, updatedAt: NOW }]);
    },
  );

  it.each(['no_package', 'multiple_packages', 'url_rejected', 'malformed_response', 'packages_api_disabled'] as const)(
    'a vendor verdict (%s) clears the stored link, so an old package is never dispatched',
    async (code) => {
      const { tx, sets } = fakeTx();
      await persistInstallerOutcomes(tx, 'bitdefender', [{ tenantId: TENANT_A, ok: false, code }], NOW);
      expect(sets).toEqual([{
        installerSecretEncrypted: null, installerFetchedAt: null, installerExpiresAt: null, installerFetchError: code, updatedAt: NOW,
      }]);
    },
  );

  it('a material that cannot be sealed records vendor_error instead of failing the inventory run', async () => {
    const { tx, sets } = fakeTx();
    // An empty row id is refused by the row-bound AAD.
    await persistInstallerOutcomes(tx, 'bitdefender', [{ tenantId: '', ok: true, data: envelope.data, expiresAt: null }], NOW);
    expect(sets).toEqual([{ installerFetchError: 'vendor_error', updatedAt: NOW }]);
  });

  it('an ok outcome with no data is a malformed response, never a sealed empty envelope', async () => {
    const { tx, sets } = fakeTx();
    await persistInstallerOutcomes(tx, 'bitdefender', [{ tenantId: TENANT_A, ok: true, data: undefined, expiresAt: null }], NOW);
    expect(sets).toEqual([{
      installerSecretEncrypted: null, installerFetchedAt: null, installerExpiresAt: null, installerFetchError: 'malformed_response', updatedAt: NOW,
    }]);
  });

  it('writes nothing for no outcomes', async () => {
    const { tx, update } = fakeTx();
    await persistInstallerOutcomes(tx, 'bitdefender', [], NOW);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('clearTenantInstallerMaterial', () => {
  it.each([
    ['one connection', { connectionId: 'conn' }],
    ['one tenant', { tenantId: TENANT_A }],
  ])('clears the secret and all three status columns for %s', async (_label, where) => {
    const { tx, sets } = fakeTx([{ id: TENANT_A }, { id: TENANT_B }]);
    await expect(clearTenantInstallerMaterial(tx, where)).resolves.toBe(2);
    expect(sets[0]).toMatchObject({
      installerSecretEncrypted: null, installerFetchedAt: null, installerExpiresAt: null, installerFetchError: null,
    });
  });
});

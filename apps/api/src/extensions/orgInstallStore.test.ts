import { describe, expect, it } from 'vitest';
import {
  ExtensionOrgInstallStore,
  type ExtensionOrgInstallBackend,
  type ExtensionOrgInstallRow,
} from './orgInstallStore';

function memoryBackend(rows: ExtensionOrgInstallRow[]): ExtensionOrgInstallBackend {
  return {
    getRow: async (extension, orgId) =>
      rows.find((r) => r.extensionName === extension && r.orgId === orgId) ?? null,
    listRows: async (extension) => rows.filter((r) => r.extensionName === extension),
  };
}

describe('ExtensionOrgInstallStore', () => {
  const rows: ExtensionOrgInstallRow[] = [
    { extensionName: 'demo', orgId: 'org-enabled', enabled: true },
    { extensionName: 'demo', orgId: 'org-disabled', enabled: false },
    { extensionName: 'other', orgId: 'org-enabled', enabled: true },
  ];

  it('isInstalled: true only for a present, enabled row', async () => {
    const store = new ExtensionOrgInstallStore(memoryBackend(rows));
    await expect(store.isInstalled('demo', 'org-enabled')).resolves.toBe(true);
    await expect(store.isInstalled('demo', 'org-disabled')).resolves.toBe(false);
    await expect(store.isInstalled('demo', 'org-absent')).resolves.toBe(false);
  });

  it('installedOrgs: enabled rows only, empty array when none', async () => {
    const store = new ExtensionOrgInstallStore(memoryBackend(rows));
    await expect(store.installedOrgs('demo')).resolves.toEqual(['org-enabled']);
    await expect(store.installedOrgs('unknown')).resolves.toEqual([]);
  });

  it('propagates backend errors (unreadable ≠ empty)', async () => {
    const store = new ExtensionOrgInstallStore({
      getRow: async () => { throw new Error('db down'); },
      listRows: async () => { throw new Error('db down'); },
    });
    await expect(store.isInstalled('demo', 'org-enabled')).rejects.toThrow('db down');
    await expect(store.installedOrgs('demo')).rejects.toThrow('db down');
  });
});

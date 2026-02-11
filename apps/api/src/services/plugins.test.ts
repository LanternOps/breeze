import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { subscribeMock, unsubscribeMock, randomUuidMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  unsubscribeMock: vi.fn(),
  randomUuidMock: vi.fn(() => 'uuid-1')
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  pluginCatalog: {
    id: 'id',
    name: 'name',
    version: 'version',
    type: 'type',
    permissions: 'permissions',
    hooks: 'hooks',
    downloadUrl: 'downloadUrl',
    installCount: 'installCount'
  },
  pluginInstallations: {
    id: 'id',
    orgId: 'orgId',
    catalogId: 'catalogId',
    version: 'version',
    status: 'status',
    enabled: 'enabled',
    config: 'config',
    permissions: 'permissions',
    sandboxEnabled: 'sandboxEnabled',
    resourceLimits: 'resourceLimits',
    installedAt: 'installedAt',
    installedBy: 'installedBy',
    lastActiveAt: 'lastActiveAt',
    errorMessage: 'errorMessage',
    updatedAt: 'updatedAt'
  },
  pluginLogs: {
    installationId: 'installationId',
    level: 'level',
    message: 'message',
    context: 'context',
    timestamp: 'timestamp'
  }
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args }))
}));

vi.mock('./eventBus', () => ({
  getEventBus: vi.fn(() => ({
    subscribe: subscribeMock.mockReturnValue(unsubscribeMock)
  })),
  EventType: {},
  BreezeEvent: {}
}));

vi.mock('crypto', () => ({
  randomUUID: randomUuidMock
}));
import {
  PluginLoader,
  PluginSandbox,
  PluginEventBridge,
  getPluginEventBridge,
  getPluginLoader,
  getPluginSandbox,
  initPluginEventBridge,
  installPlugin,
  uninstallPlugin,
  executePlugin,
  dispatchPluginEvent
} from './plugins';
import type { PluginInstallStatus } from './plugins';
import * as plugins from './plugins';
import { db } from '../db';

const createSelectLimitMock = (result: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(result)
    })
  })
});
const globalWithFetch = globalThis as typeof globalThis & { fetch: any };

describe('plugins service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeMock.mockReturnValue(unsubscribeMock);
    randomUuidMock.mockReturnValue('uuid-1');
    globalWithFetch.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('singletons', () => {
    it('returns singleton instances', () => {
      const loaderA = getPluginLoader();
      const loaderB = getPluginLoader();
      const sandboxA = getPluginSandbox();
      const sandboxB = getPluginSandbox();
      const bridgeA = getPluginEventBridge();
      const bridgeB = getPluginEventBridge();

      expect(loaderA).toBe(loaderB);
      expect(sandboxA).toBe(sandboxB);
      expect(bridgeA).toBe(bridgeB);
    });

    it('initializes the plugin event bridge', () => {
      const bridge = getPluginEventBridge();
      const initSpy = vi.spyOn(bridge, 'init');

      initPluginEventBridge();

      expect(initSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('PluginLoader', () => {
    const manifest = {
      name: 'Test Plugin',
      version: '1.0.0',
      type: 'integration' as const,
      permissions: ['read:devices'],
      hooks: ['device.online', 'alert.triggered'],
      config: {
        apiKey: { type: 'string' as const, required: true }
      },
      entryPoint: 'https://example.com/plugin'
    };

    it('loads a manifest from the catalog', async () => {
      const catalogEntry = {
        id: 'catalog-1',
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        permissions: manifest.permissions,
        hooks: manifest.hooks,
        downloadUrl: manifest.entryPoint
      };

      vi.mocked(db.select).mockReturnValue(createSelectLimitMock([catalogEntry]) as any);

      const loader = new PluginLoader();
      const result = await loader.loadManifest('catalog-1');

      expect(result).toEqual({
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        permissions: manifest.permissions,
        hooks: manifest.hooks,
        config: {},
        entryPoint: manifest.entryPoint
      });
    });

    it('throws when the catalog entry is missing', async () => {
      vi.mocked(db.select).mockReturnValue(createSelectLimitMock([]) as any);
      const loader = new PluginLoader();

      await expect(loader.loadManifest('missing')).rejects.toThrow('Plugin not found in catalog: missing');
    });

    it('loads a manifest from a URL', async () => {
      vi.mocked(globalWithFetch.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(manifest)
      });

      const loader = new PluginLoader();
      const result = await loader.loadManifestFromUrl('https://example.com/manifest.json');

      expect(result).toEqual(manifest);
    });

    it('fails to load a manifest with invalid data', async () => {
      vi.mocked(globalWithFetch.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...manifest, name: '' })
      });

      const loader = new PluginLoader();

      await expect(loader.loadManifestFromUrl('https://example.com/manifest.json'))
        .rejects
        .toThrow('Invalid manifest: missing or invalid name');
    });

    it('installs a plugin and registers hooks', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);

      const registerHook = vi.fn();
      vi.spyOn(plugins, 'getPluginEventBridge')
        .mockReturnValue({ registerHook } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(createSelectLimitMock([]) as any)
        .mockReturnValueOnce(createSelectLimitMock([{ count: 2 }]) as any);

      const installation = {
        id: 'inst-1',
        orgId: 'org-1',
        catalogId: 'catalog-1',
        version: manifest.version,
        status: 'installing',
        enabled: true,
        config: { apiKey: 'secret' },
        permissions: manifest.permissions,
        hooks: manifest.hooks,
        sandboxEnabled: true,
        resourceLimits: {
          maxMemoryMB: 128,
          maxExecutionTimeMs: 30000,
          maxConcurrentExecutions: 5
        },
        installedAt: new Date(),
        installedBy: 'user-1',
        lastActiveAt: null,
        errorMessage: null
      };

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([installation])
        })
      } as any);
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      const result = await loader.installPlugin('org-1', 'catalog-1', { apiKey: 'secret' }, 'user-1');

      expect(registerHook).toHaveBeenCalledTimes(manifest.hooks.length);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'installed' }));
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ installCount: 3 }));
      expect(result).toMatchObject({
        id: installation.id,
        orgId: installation.orgId,
        catalogId: installation.catalogId,
        hooks: manifest.hooks,
        entryPoint: manifest.entryPoint,
        name: manifest.name
      });
    });

    it('throws when the plugin is already installed', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);
      vi.mocked(db.select).mockReturnValue(createSelectLimitMock([{ id: 'inst-1' }]) as any);

      await expect(loader.installPlugin('org-1', 'catalog-1', { apiKey: 'secret' }))
        .rejects
        .toThrow('Plugin Test Plugin is already installed for this organization');
    });

    it('marks installation as error on failure', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);

      const registerHook = vi.fn(() => {
        throw new Error('hook failure');
      });
      vi.spyOn(plugins, 'getPluginEventBridge')
        .mockReturnValue({ registerHook } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(createSelectLimitMock([]) as any)
        .mockReturnValueOnce(createSelectLimitMock([{ count: 0 }]) as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'inst-2',
            orgId: 'org-1',
            catalogId: 'catalog-1',
            version: manifest.version,
            status: 'installing',
            enabled: true,
            config: { apiKey: 'secret' },
            permissions: manifest.permissions,
            sandboxEnabled: true,
            resourceLimits: null,
            installedAt: new Date(),
            installedBy: null,
            lastActiveAt: null,
            errorMessage: null
          }])
        })
      } as any);
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      await expect(loader.installPlugin('org-1', 'catalog-1', { apiKey: 'secret' }))
        .rejects
        .toThrow('hook failure');

      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('uninstalls a plugin and unregisters hooks', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);

      const unregisterHook = vi.fn();
      vi.spyOn(plugins, 'getPluginEventBridge')
        .mockReturnValue({ unregisterHook } as any);

      const installation = {
        id: 'inst-3',
        orgId: 'org-1',
        catalogId: 'catalog-1'
      };

      vi.mocked(db.select)
        .mockReturnValueOnce(createSelectLimitMock([installation]) as any)
        .mockReturnValueOnce(createSelectLimitMock([{ count: 2 }]) as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      await loader.uninstallPlugin('org-1', 'inst-3');

      expect(unregisterHook).toHaveBeenCalledTimes(manifest.hooks.length);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'uninstalling' }));
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ installCount: 1 }));
    });

    it('throws when uninstalling a missing plugin', async () => {
      const loader = new PluginLoader();
      vi.mocked(db.select).mockReturnValue(createSelectLimitMock([]) as any);

      await expect(loader.uninstallPlugin('org-1', 'inst-missing'))
        .rejects
        .toThrow('Plugin installation not found: inst-missing');
    });

    it('returns installed plugins for an organization', async () => {
      const loader = new PluginLoader();
      const rows = [{
        installation: {
          id: 'inst-4',
          orgId: 'org-1',
          catalogId: 'catalog-1',
          version: '1.2.3',
          status: 'installed',
          enabled: true,
          config: { key: 'value' },
          permissions: ['read:*'],
          sandboxEnabled: true,
          resourceLimits: null,
          installedAt: null,
          installedBy: null,
          lastActiveAt: null,
          errorMessage: null
        },
        catalog: {
          name: 'Catalog Plugin',
          hooks: ['device.online'],
          downloadUrl: 'https://example.com/plugin'
        }
      }];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows)
          })
        })
      } as any);

      const result = await loader.getInstalledPlugins('org-1');

      expect(result).toEqual([{
        id: 'inst-4',
        orgId: 'org-1',
        catalogId: 'catalog-1',
        version: '1.2.3',
        status: 'installed',
        enabled: true,
        config: { key: 'value' },
        permissions: ['read:*'],
        hooks: ['device.online'],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: 'https://example.com/plugin',
        name: 'Catalog Plugin'
      }]);
    });

    it('returns a single installation by id', async () => {
      const loader = new PluginLoader();
      const rows = [{
        installation: {
          id: 'inst-5',
          orgId: 'org-1',
          catalogId: 'catalog-1',
          version: '1.2.3',
          status: 'installed',
          enabled: true,
          config: { key: 'value' },
          permissions: ['read:*'],
          sandboxEnabled: true,
          resourceLimits: null,
          installedAt: null,
          installedBy: null,
          lastActiveAt: null,
          errorMessage: null
        },
        catalog: {
          name: 'Catalog Plugin',
          hooks: ['device.online'],
          downloadUrl: 'https://example.com/plugin'
        }
      }];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows)
            })
          })
        })
      } as any);

      const result = await loader.getInstallation('inst-5');

      expect(result?.id).toBe('inst-5');
      expect(result?.entryPoint).toBe('https://example.com/plugin');
    });

    it('toggles plugin enabled state', async () => {
      const loader = new PluginLoader();
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });

      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      await loader.setPluginEnabled('inst-6', false);

      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      expect(db.insert).toHaveBeenCalled();
    });

    it('updates plugin configuration', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'getInstallation').mockResolvedValue({
        id: 'inst-7',
        orgId: 'org-1',
        catalogId: 'catalog-1',
        version: '1.0.0',
        status: 'installed',
        enabled: true,
        config: {},
        permissions: ['read:*'],
        hooks: [],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: '',
        name: 'Plugin'
      });
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      await loader.updateConfig('inst-7', { apiKey: 'secret' });

      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ config: { apiKey: 'secret' } }));
    });

    it('fails updateConfig when required config is missing', async () => {
      const loader = new PluginLoader();
      vi.spyOn(loader, 'getInstallation').mockResolvedValue({
        id: 'inst-8',
        orgId: 'org-1',
        catalogId: 'catalog-1',
        version: '1.0.0',
        status: 'installed',
        enabled: true,
        config: {},
        permissions: ['read:*'],
        hooks: [],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: '',
        name: 'Plugin'
      });
      vi.spyOn(loader, 'loadManifest').mockResolvedValue(manifest);

      await expect(loader.updateConfig('inst-8', {}))
        .rejects
        .toThrow('Missing required configuration: apiKey');
    });
  });

  describe('PluginSandbox', () => {
    const basePlugin = {
      id: 'plugin-1',
      orgId: 'org-1',
      catalogId: 'catalog-1',
      version: '1.0.0',
      status: 'installed' as const,
      enabled: true,
      config: { key: 'value' },
      permissions: ['read:*'],
      hooks: ['device.online'],
      sandboxEnabled: true,
      resourceLimits: { maxConcurrentExecutions: 2, maxExecutionTimeMs: 5000 },
      installedAt: null,
      installedBy: null,
      lastActiveAt: null,
      errorMessage: null,
      entryPoint: '',
      name: 'Plugin'
    };

    it('returns error when plugin is disabled', async () => {
      const sandbox = new PluginSandbox();
      const result = await sandbox.execute({ ...basePlugin, enabled: false }, 'device.online', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Plugin is disabled');
    });

    it('returns error when plugin is not installed', async () => {
      const sandbox = new PluginSandbox();
      const result = await sandbox.execute({ ...basePlugin, status: 'installing' }, 'device.online', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('returns error when hook is not registered', async () => {
      const sandbox = new PluginSandbox();
      const result = await sandbox.execute(basePlugin, 'alert.triggered', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Plugin is not registered for hook: alert.triggered');
    });

    it('blocks execution when concurrent limit is reached', async () => {
      const sandbox = new PluginSandbox();
      (sandbox as any).executionCount.set(basePlugin.id, 2);

      const result = await sandbox.execute(basePlugin, 'device.online', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Maximum concurrent executions reached');
    });

    it('executes successfully and updates last active time', async () => {
      const sandbox = new PluginSandbox();
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const result = await sandbox.execute(basePlugin, 'device.online', { payload: true });

      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ acknowledged: true, hook: 'device.online' });
      expect(db.update).toHaveBeenCalled();
    });

    it('logs and returns error when execution throws', async () => {
      const sandbox = new PluginSandbox();
      vi.spyOn(sandbox as any, 'executeWithTimeout').mockRejectedValue(new Error('boom'));
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const result = await sandbox.execute(basePlugin, 'device.online', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('validates permissions with wildcards', () => {
      const sandbox = new PluginSandbox();
      expect(sandbox.validatePermissions(basePlugin, ['read:devices'])).toBe(true);
      expect(sandbox.validatePermissions({ ...basePlugin, permissions: ['read:*'] }, ['read:devices'])).toBe(true);
      expect(sandbox.validatePermissions({ ...basePlugin, permissions: ['*'] }, ['write:alerts'])).toBe(true);
      expect(sandbox.validatePermissions({ ...basePlugin, permissions: ['read:devices'] }, ['write:alerts'])).toBe(false);
    });

    it('returns execution status counts', () => {
      const sandbox = new PluginSandbox();
      (sandbox as any).executionCount.set('plugin-1', 3);

      expect(sandbox.getExecutionStatus('plugin-1')).toEqual({ currentExecutions: 3 });
    });
  });

  describe('PluginEventBridge', () => {
    it('registers and unregisters hooks', () => {
      const bridge = new PluginEventBridge();
      bridge.registerHook('plugin-1', 'device.online');

      expect(bridge.isRegistered('plugin-1', 'device.online')).toBe(true);
      expect(bridge.getPluginHooks('plugin-1')).toEqual(['device.online']);
      expect(bridge.getHookPlugins('device.online')).toEqual(['plugin-1']);

      bridge.unregisterHook('plugin-1', 'device.online');
      expect(bridge.isRegistered('plugin-1', 'device.online')).toBe(false);
    });

    it('unregisters all hooks for a plugin', () => {
      const bridge = new PluginEventBridge();
      bridge.registerHook('plugin-1', 'device.online');
      bridge.registerHook('plugin-1', 'alert.triggered');

      bridge.unregisterPlugin('plugin-1');

      expect(bridge.getPluginHooks('plugin-1')).toEqual([]);
      expect(bridge.getHookPlugins('device.online')).toEqual([]);
    });

    it('initializes and shuts down the bridge', () => {
      const bridge = new PluginEventBridge();
      bridge.init();
      bridge.init();

      expect(subscribeMock).toHaveBeenCalledTimes(1);

      bridge.shutdown();

      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it('dispatches events to matching plugins', async () => {
      const bridge = new PluginEventBridge();
      bridge.registerHook('plugin-1', 'device.online');

      const sandboxExecute = vi.fn().mockResolvedValue({ success: true });
      const loaderGetInstallation = vi.fn().mockResolvedValue({
        id: 'plugin-1',
        orgId: 'org-1',
        name: 'Plugin',
        version: '1.0.0',
        status: 'installed',
        enabled: true,
        config: {},
        permissions: [],
        hooks: ['device.online'],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: '',
        catalogId: 'catalog-1'
      });

      vi.spyOn(plugins, 'getPluginSandbox')
        .mockReturnValue({ execute: sandboxExecute } as any);
      vi.spyOn(plugins, 'getPluginLoader')
        .mockReturnValue({ getInstallation: loaderGetInstallation } as any);

      await bridge.dispatchEvent('device.online', { payload: true }, 'org-1');

      expect(sandboxExecute).toHaveBeenCalledWith(expect.objectContaining({ id: 'plugin-1' }), 'device.online', { payload: true });
    });

    it('skips plugins outside the org filter', async () => {
      const bridge = new PluginEventBridge();
      bridge.registerHook('plugin-1', 'device.online');

      const sandboxExecute = vi.fn().mockResolvedValue({ success: true });
      const loaderGetInstallation = vi.fn().mockResolvedValue({
        id: 'plugin-1',
        orgId: 'other-org',
        name: 'Plugin',
        version: '1.0.0',
        status: 'installed',
        enabled: true,
        config: {},
        permissions: [],
        hooks: ['device.online'],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: '',
        catalogId: 'catalog-1'
      });

      vi.spyOn(plugins, 'getPluginSandbox')
        .mockReturnValue({ execute: sandboxExecute } as any);
      vi.spyOn(plugins, 'getPluginLoader')
        .mockReturnValue({ getInstallation: loaderGetInstallation } as any);

      await bridge.dispatchEvent('device.online', { payload: true }, 'org-1');

      expect(sandboxExecute).not.toHaveBeenCalled();
    });

    it('cleans up stale registrations', async () => {
      const bridge = new PluginEventBridge();
      bridge.registerHook('plugin-1', 'device.online');

      const unregisterSpy = vi.spyOn(bridge, 'unregisterPlugin');
      vi.spyOn(plugins, 'getPluginSandbox')
        .mockReturnValue({ execute: vi.fn() } as any);
      vi.spyOn(plugins, 'getPluginLoader')
        .mockReturnValue({ getInstallation: vi.fn().mockResolvedValue(null) } as any);

      await bridge.dispatchEvent('device.online', { payload: true });

      expect(unregisterSpy).toHaveBeenCalledWith('plugin-1');
    });
  });

  describe('convenience functions', () => {
    it('delegates installPlugin and uninstallPlugin', async () => {
      const loader = {
        installPlugin: vi.fn().mockResolvedValue({ id: 'inst-1' }),
        uninstallPlugin: vi.fn().mockResolvedValue(undefined)
      };
      vi.spyOn(plugins, 'getPluginLoader')
        .mockReturnValue(loader as any);

      const result = await installPlugin('org-1', 'catalog-1', { key: 'value' }, 'user-1');
      await uninstallPlugin('org-1', 'inst-1');

      expect(result).toEqual({ id: 'inst-1' });
      expect(loader.installPlugin).toHaveBeenCalledWith('org-1', 'catalog-1', { key: 'value' }, 'user-1');
      expect(loader.uninstallPlugin).toHaveBeenCalledWith('org-1', 'inst-1');
    });

    it('delegates executePlugin and dispatchPluginEvent', async () => {
      const sandbox = { execute: vi.fn().mockResolvedValue({ success: true }) };
      const bridge = { dispatchEvent: vi.fn().mockResolvedValue(undefined) };
      vi.spyOn(plugins, 'getPluginSandbox')
        .mockReturnValue(sandbox as any);
      vi.spyOn(plugins, 'getPluginEventBridge')
        .mockReturnValue(bridge as any);

      const plugin = {
        id: 'plugin-1',
        orgId: 'org-1',
        catalogId: 'catalog-1',
        version: '1.0.0',
        status: 'installed' as PluginInstallStatus,
        enabled: true,
        config: {},
        permissions: [],
        hooks: ['device.online'],
        sandboxEnabled: true,
        resourceLimits: null,
        installedAt: null,
        installedBy: null,
        lastActiveAt: null,
        errorMessage: null,
        entryPoint: '',
        name: 'Plugin'
      };

      const result = await executePlugin(plugin, 'device.online', { payload: true });
      await dispatchPluginEvent('device.online', { payload: true }, 'org-1');

      expect(result).toMatchObject({ success: true });
      expect(sandbox.execute).toHaveBeenCalledWith(plugin, 'device.online', { payload: true });
      expect(bridge.dispatchEvent).toHaveBeenCalledWith('device.online', { payload: true }, 'org-1');
    });
  });
});

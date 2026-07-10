import { describe, it, expect } from 'vitest';
import { parseExtensionManifest } from './index';

describe('parseExtensionManifest', () => {
  const valid = {
    name: 'workspace',
    routeNamespace: 'workspace',
    entry: 'src/index.ts',
    migrationsDir: 'migrations',
    tenancy: {
      orgCascadeDeleteTables: ['workspace_sources'],
      deviceOrgDenormalizedTables: ['workspace_file_activity'],
    },
  };

  it('accepts a valid manifest and applies defaults', () => {
    const m = parseExtensionManifest({ ...valid, migrationsDir: undefined });
    expect(m.name).toBe('workspace');
    expect(m.migrationsDir).toBe('migrations'); // default
    expect(m.tenancy.deviceCascadeDeleteTables).toEqual([]); // default
  });

  it('rejects invalid names (uppercase, spaces, leading digit, "plugins")', () => {
    for (const name of ['Workspace', 'work space', '1workspace', 'plugins']) {
      expect(() => parseExtensionManifest({ ...valid, name })).toThrow();
    }
  });

  it('reports invalid names with a human-readable validation message', () => {
    expect(() => parseExtensionManifest({ ...valid, name: 'NOT VALID' })).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/name|pattern/i),
      })
    );

    try {
      parseExtensionManifest({ ...valid, name: 'NOT VALID' });
    } catch (err) {
      expect((err as Error).message).not.toContain('"code":');
    }
  });

  it('rejects a routeNamespace that collides with core mounts', () => {
    for (const ns of ['plugins', 'devices', 'auth', 'ai', 'mcp']) {
      expect(() => parseExtensionManifest({ ...valid, routeNamespace: ns })).toThrow();
    }
  });

  it('rejects table names not starting with the extension name prefix, except memory_blocks', () => {
    expect(() =>
      parseExtensionManifest({
        ...valid,
        tenancy: { orgCascadeDeleteTables: ['devices'] },
      })
    ).toThrow(/must be prefixed/);
    // memory_blocks is the deliberate shared Wick table — allowlisted
    expect(() =>
      parseExtensionManifest({
        ...valid,
        tenancy: { orgCascadeDeleteTables: ['memory_blocks'] },
      })
    ).not.toThrow();
  });
});

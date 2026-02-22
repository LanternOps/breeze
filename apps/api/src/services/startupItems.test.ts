import { describe, expect, it } from 'vitest';
import {
  computeStartupItemId,
  normalizeStartupItems,
  resolveStartupItem,
} from './startupItems';

describe('startupItems helpers', () => {
  it('computes deterministic item ids from type/path', () => {
    const id = computeStartupItemId({
      type: 'Service',
      path: 'C:\\Program Files\\Vendor\\App.exe',
    });
    expect(id).toBe('service|c:/program files/vendor/app.exe');
  });

  it('normalizes startup items and de-duplicates by item id', () => {
    const items = normalizeStartupItems([
      {
        name: 'One',
        type: 'service',
        path: '/usr/bin/one',
        enabled: true,
        cpuTimeMs: 100,
        diskIoBytes: 50,
        impactScore: 2.5,
      },
      {
        name: 'One duplicate',
        type: 'service',
        path: '/usr/bin/one',
        enabled: true,
        cpuTimeMs: 200,
        diskIoBytes: 100,
        impactScore: 5,
      },
      null,
    ] as any[]);

    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe('service|/usr/bin/one');
  });

  it('returns ambiguity when name-only selection matches multiple items', () => {
    const items = normalizeStartupItems([
      { name: 'Updater', type: 'run_key', path: 'HKCU:Updater', enabled: true, cpuTimeMs: 0, diskIoBytes: 0, impactScore: 0 },
      { name: 'Updater', type: 'service', path: 'VendorUpdater', enabled: true, cpuTimeMs: 0, diskIoBytes: 0, impactScore: 0 },
    ] as any[]);

    const result = resolveStartupItem(items, { itemName: 'Updater' });
    expect(result.item).toBeUndefined();
    expect(result.error).toContain('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  it('resolves unique item when itemType and itemPath are supplied', () => {
    const items = normalizeStartupItems([
      { name: 'Updater', type: 'run_key', path: 'HKCU:Updater', enabled: true, cpuTimeMs: 0, diskIoBytes: 0, impactScore: 0 },
      { name: 'Updater', type: 'service', path: 'VendorUpdater', enabled: true, cpuTimeMs: 0, diskIoBytes: 0, impactScore: 0 },
    ] as any[]);

    const result = resolveStartupItem(items, {
      itemName: 'Updater',
      itemType: 'service',
      itemPath: 'VendorUpdater',
    });
    expect(result.error).toBeUndefined();
    expect(result.item?.type).toBe('service');
    expect(result.item?.path).toBe('VendorUpdater');
  });
});


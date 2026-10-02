import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  conn: null as Record<string, unknown> | null,
  set: undefined as Record<string, unknown> | undefined,
  returning: [] as Array<{ id: string }>,
  lockedPartners: [] as string[],
}));

vi.mock('./connections', () => ({ getConnection: vi.fn(async () => h.conn) }));
// Every W04 registry write runs behind the partner registry lock (ruling).
vi.mock('./offeringWrites', () => ({
  inPartnerRegistryWrite: vi.fn(async (partnerId: string, _label: string, _msg: string, fn: () => Promise<unknown>) => {
    h.lockedPartners.push(partnerId);
    return fn();
  }),
}));
vi.mock('../../db', () => ({
  db: {
    update: () => ({
      set: (s: Record<string, unknown>) => {
        h.set = s;
        return { where: () => ({ returning: async () => h.returning }) };
      },
    }),
  },
}));

import { updateConnectionSettings } from './connectionSettings';

const P = '22222222-2222-4222-8222-222222222222';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => { h.conn = null; h.set = undefined; h.returning = [{ id: C }]; h.lockedPartners = []; });

describe('updateConnectionSettings', () => {
  it('renames without bumping config_version, under the partner registry lock', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'Prod key' } });
    expect(h.set).toMatchObject({ name: 'Prod key' });
    expect(h.set).not.toHaveProperty('configVersion');
    expect(h.set).not.toHaveProperty('inferenceGeo');
    expect(h.lockedPartners).toEqual([P]);
  });

  it('bumps config_version when inference geo changes', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { inferenceGeo: 'eu' } });
    expect(h.set).toMatchObject({ inferenceGeo: 'eu' });
    expect(h.set).toHaveProperty('configVersion');
  });

  it('bumps config_version when inference geo is cleared', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: 'eu', configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { inferenceGeo: null } });
    expect(h.set).toMatchObject({ inferenceGeo: null });
    expect(h.set).toHaveProperty('configVersion');
  });

  it('does not bump config_version when the geo is unchanged', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: 'eu', configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { inferenceGeo: 'eu' } });
    expect(h.set).not.toHaveProperty('configVersion');
  });

  it('404s another partner’s connection and writes nothing', async () => {
    h.conn = { id: C, partnerId: 'other', inferenceGeo: null, configVersion: 1 };
    const err = await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
    expect(h.set).toBeUndefined();
  });

  // W03 soft-disconnect: getConnection still returns the provenance row.
  it('404s a disconnected connection and writes nothing', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 2, status: 'disconnected' };
    const err = await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x', inferenceGeo: 'eu' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
    expect(h.set).toBeUndefined();
  });

  it('a connection in error is still editable', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 2, status: 'error' };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x' } });
    expect(h.set).toMatchObject({ name: 'x' });
  });

  it('404s a missing connection', async () => {
    const err = await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
  });

  it('404s when the partner-pinned update matches no row', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 1 };
    h.returning = [];
    const err = await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
  });
});

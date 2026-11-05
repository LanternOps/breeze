import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const CONFIG = '00000000-0000-4000-8000-0000000000e1';
const CONNECTION = '00000000-0000-4000-8000-0000000000e2';
const STORAGE = '00000000-0000-4000-8000-0000000000e3';

const { selectQueue, insertReturning, updateReturning, deleteReturning, holding, dbContext } = vi.hoisted(() => ({
  dbContext: { active: false, withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()) },
  selectQueue: [] as unknown[][],
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  deleteReturning: vi.fn(),
  holding: { isHoldingOrg: vi.fn() },
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbContext.active,
  withDbTransaction: (fn: () => Promise<unknown>) => dbContext.withDbTransaction(fn),
  db: {
    select: vi.fn(() => {
      // One queue entry per query, taken when it is awaited, whichever call ends the chain.
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.then = (resolve: (rows: unknown[]) => unknown) => resolve(selectQueue.shift() ?? []);
      return chain;
    }),
    insert: vi.fn(() => ({ values: () => ({ returning: insertReturning }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: updateReturning }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: deleteReturning }) })),
  },
}));
vi.mock('./unassignedPool/protectedOrg', () => ({ ...holding }));

import { db } from '../db';
import { createC2cConfig, deleteC2cConfig, listC2cConfigs, toC2cConfigResponse, updateC2cConfig } from './c2cConfigService';

const NOW = new Date('2026-11-04T00:00:00.000Z');
const ROW = {
  id: CONFIG, orgId: ORG, connectionId: CONNECTION, name: 'Finance', backupScope: 'mail', targetUsers: ['a@example.test'],
  storageConfigId: null, schedule: { frequency: 'daily' }, retention: null, isActive: true, createdAt: NOW, updatedAt: NOW,
};
const CREATE = { connectionId: CONNECTION, name: 'Finance', backupScope: 'mail' as never, storageConfigId: STORAGE };

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  holding.isHoldingOrg.mockResolvedValue(false);
  insertReturning.mockResolvedValue([ROW]);
  updateReturning.mockResolvedValue([ROW]);
  deleteReturning.mockResolvedValue([ROW]);
});

describe('c2cConfigService', () => {
  it('lists the org configs', async () => {
    selectQueue.push([ROW]);
    expect(await listC2cConfigs(ORG)).toEqual([ROW]);
  });

  it('service: a connection in another org → CONNECTION_NOT_FOUND', async () => {
    selectQueue.push([]);
    expect(await createC2cConfig(ORG, CREATE)).toEqual({ ok: false, code: 'CONNECTION_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('service: storage config in another org → STORAGE_NOT_FOUND', async () => {
    selectQueue.push([{ id: CONNECTION }], []);
    expect(await createC2cConfig(ORG, CREATE)).toEqual({ ok: false, code: 'STORAGE_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();

    selectQueue.push([]);
    expect(await updateC2cConfig(ORG, CONFIG, { storageConfigId: STORAGE })).toEqual({ ok: false, code: 'STORAGE_NOT_FOUND' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('service: holding org refused on create', async () => {
    holding.isHoldingOrg.mockResolvedValue(true);
    expect(await createC2cConfig(ORG, CREATE)).toEqual({ ok: false, code: 'PROTECTED_ORG' });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('creates and returns the row', async () => {
    selectQueue.push([{ id: CONNECTION }], [{ id: STORAGE }]);
    expect(await createC2cConfig(ORG, CREATE)).toEqual({ ok: true, value: ROW });
  });

  it('update and delete of a row the org does not hold → NOT_FOUND', async () => {
    updateReturning.mockResolvedValue([]);
    expect(await updateC2cConfig(ORG, CONFIG, { name: 'x' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    deleteReturning.mockResolvedValue([]);
    selectQueue.push([], []);
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('service: delete with jobs or items → CONFIG_HAS_HISTORY, without attempting the delete', async () => {
    selectQueue.push([{ id: 'job-1' }]);
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: false, code: 'CONFIG_HAS_HISTORY' });
    selectQueue.push([], [{ id: 'item-1' }]);
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: false, code: 'CONFIG_HAS_HISTORY' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('service: a job that appears after the check is a 23503, mapped to CONFIG_HAS_HISTORY', async () => {
    selectQueue.push([], []);
    deleteReturning.mockRejectedValue(Object.assign(new Error('fk'), { code: '23503', constraint_name: 'c2c_backup_jobs_config_id_fkey' }));
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: false, code: 'CONFIG_HAS_HISTORY' });
  });

  it('a 23503 from any other foreign key is not read as history', async () => {
    selectQueue.push([], []);
    deleteReturning.mockRejectedValue(Object.assign(new Error('fk'), { code: '23503', constraint_name: 'some_other_fkey' }));
    await expect(deleteC2cConfig(ORG, CONFIG)).rejects.toThrow('fk');
  });

  it('the delete runs inside a savepoint when there is an ambient transaction', async () => {
    dbContext.active = true;
    selectQueue.push([], []);
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: true, value: ROW });
    expect(dbContext.withDbTransaction).toHaveBeenCalledTimes(1);
    dbContext.active = false;
  });

  it('any other delete failure propagates', async () => {
    selectQueue.push([], []);
    deleteReturning.mockRejectedValue(new Error('connection lost'));
    await expect(deleteC2cConfig(ORG, CONFIG)).rejects.toThrow('connection lost');
  });

  it('deletes a config with no history', async () => {
    selectQueue.push([], []);
    expect(await deleteC2cConfig(ORG, CONFIG)).toEqual({ ok: true, value: ROW });
  });

  it('serializes a row without its org', () => {
    expect(toC2cConfigResponse(ROW as never)).toEqual({
      id: CONFIG, connectionId: CONNECTION, name: 'Finance', backupScope: 'mail', targetUsers: ['a@example.test'],
      storageConfigId: null, schedule: { frequency: 'daily' }, retention: null, isActive: true,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { selectMock, executeMock, readWithPartnerAxisVisibilityMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  executeMock: vi.fn(),
  readWithPartnerAxisVisibilityMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db', () => ({ db: { select: selectMock, execute: executeMock } }));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: readWithPartnerAxisVisibilityMock,
}));

import { deviceCommandsInCurrentOrg } from './commandOrgScope';

const DEVICE = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const LOSER_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENURE_START = '2026-11-01 10:00:00.123456+00';

function epochRead(row: unknown) {
  return { from: () => ({ where: async () => (row === undefined ? [] : [row]) }) };
}

function render(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

describe('deviceCommandsInCurrentOrg', () => {
  beforeEach(() => {
    selectMock.mockReset();
    executeMock.mockReset();
    readWithPartnerAxisVisibilityMock.mockClear();
  });

  it('a device that never moved: stamped rows and every unstamped row, on the caller connection', async () => {
    selectMock.mockReturnValueOnce(epochRead({ epochCount: 1, tenureStart: null, viaMerge: false }));

    const { sql, params } = render(await deviceCommandsInCurrentOrg(DEVICE));

    expect(params).toEqual([DEVICE.orgId]);
    expect(sql).toContain('"submitted_org_id" is null');
    expect(sql).not.toContain('"created_at"');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
  });

  it('a moved device: unstamped rows only from the start of the current tenure', async () => {
    selectMock.mockReturnValueOnce(epochRead({ epochCount: 2, tenureStart: TENURE_START, viaMerge: false }));

    const { sql, params } = render(await deviceCommandsInCurrentOrg(DEVICE));

    expect(params).toEqual([DEVICE.orgId, TENURE_START]);
    expect(sql).toContain('"created_at" >=');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
  });

  it('no epoch visible: stamped rows only, never every unstamped row', async () => {
    selectMock.mockReturnValueOnce(epochRead({ epochCount: 0, tenureStart: null, viaMerge: false }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { sql, params } = render(await deviceCommandsInCurrentOrg(DEVICE));

    expect(params).toEqual([DEVICE.orgId]);
    expect(sql).not.toContain('is null');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEVICE.id));
    warn.mockRestore();
  });

  it('a device that arrived through a merge: takes the merge lineage and the whole device tenure', async () => {
    selectMock
      .mockReturnValueOnce(epochRead({ epochCount: 1, tenureStart: null, viaMerge: true }))
      .mockReturnValueOnce(epochRead({ tenureStart: TENURE_START }));
    executeMock.mockResolvedValueOnce([{ org_id: DEVICE.orgId }, { org_id: LOSER_ORG }]);

    const { params } = render(await deviceCommandsInCurrentOrg(DEVICE));

    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(1);
    expect(params).toEqual([DEVICE.orgId, LOSER_ORG, TENURE_START]);
  });

  it('a failed read rejects rather than widening the scope', async () => {
    selectMock.mockReturnValueOnce({
      from: () => ({ where: async () => { throw new Error('connection lost'); } }),
    });

    await expect(deviceCommandsInCurrentOrg(DEVICE)).rejects.toThrow('connection lost');
  });
});

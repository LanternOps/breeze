import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #10431: a patch install job belongs to one organization. A device list that
 * spans organizations used to come back as a generic refusal ("orgId is
 * required" or "Access denied: N device(s) not in your organization"), so the
 * model had to re-query device by device to find out which org each one was
 * in. When every target device is reachable and they span more than one org,
 * install now answers with the same structured `split_by_org` payload
 * propose_script returns (#11255).
 */

const { mockSelect, mockInsert, captureExceptionMock } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => false,
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: mockSelect, insert: mockInsert },
}));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import { registerFleetTools } from './aiToolsFleet';
import type { AiTool } from './aiTools';

const toolMap = new Map<string, AiTool>();
registerFleetTools(toolMap);
const tool = toolMap.get('manage_patches')!;

const PATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEV_C = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const partnerAuth = {
  user: { id: 'u1', email: 'tech@example.com', name: 'Tech' },
  orgId: null,
  partnerId: 'partner-1',
  scope: 'partner',
  accessibleOrgIds: ['org-one', 'org-two'],
  partnerOrgAccess: 'all',
  canAccessOrg: () => true,
  // A marker the device lookup must carry, proving it is org-bounded.
  orgCondition: () => sql`${'org-scope-marker'}`,
  aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
} as any;

/** One select → from → where read, resolving to `rows`. Returns the `where` spy. */
function nextSelect(rows: unknown[] | Error) {
  const where = rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows);
  mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
  return where;
}

const ORG_NAMES = [{ id: 'org-one', name: 'Org One' }, { id: 'org-two', name: 'Org Two' }];

const install = (extra: Record<string, unknown> = {}) => tool.handler(
  { action: 'install', patchIds: [PATCH], deviceIds: [DEV_A, DEV_B, DEV_C], ...extra },
  partnerAuth,
).then((out) => JSON.parse(out));

beforeEach(() => {
  mockSelect.mockReset();
  mockInsert.mockReset();
  captureExceptionMock.mockReset();
});

describe('manage_patches:install across organizations (#10431)', () => {
  it('returns split_by_org, not the ambiguous-org error, when orgId is omitted and the devices span orgs', async () => {
    const deviceWhere = nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);
    nextSelect(ORG_NAMES);

    const out = await install();

    expect(out.error).toBe('split_by_org');
    // Insertion-ordered by the caller's list: the first device's org is first.
    expect(out.groups).toEqual([
      { orgId: 'org-one', orgName: 'Org One', deviceIds: [DEV_A, DEV_C] },
      { orgId: 'org-two', orgName: 'Org Two', deviceIds: [DEV_B] },
    ]);
    expect(out.hint).toMatch(/once per group/i);
    expect(out.hint).toMatch(/orgId/);
    expect(mockInsert).not.toHaveBeenCalled();
    // The device read is bounded by the caller's own org condition.
    const params = new PgDialect().sqlToQuery(deviceWhere.mock.calls[0]![0]).params;
    expect(params).toContain('org-scope-marker');
  });

  it('returns split_by_org, not "Access denied", when an explicit orgId owns only some of the devices', async () => {
    // The install's own ownership read (devices in org-one only).
    nextSelect([{ id: DEV_A, siteId: null }, { id: DEV_C, siteId: null }]);
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);
    nextSelect(ORG_NAMES);

    const out = await install({ orgId: 'org-one' });

    expect(out.error).toBe('split_by_org');
    expect(out.groups.map((g: { orgId: string; deviceIds: string[] }) => [g.orgId, g.deviceIds])).toEqual([
      ['org-one', [DEV_A, DEV_C]], ['org-two', [DEV_B]],
    ]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('still returns the split with null names when the org-name lookup fails', async () => {
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);
    nextSelect(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await install();
      expect(out.error).toBe('split_by_org');
      expect(out.groups.map((g: { orgName: unknown }) => g.orgName)).toEqual([null, null]);
      expect(captureExceptionMock).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('keeps the original refusal when a device is out of reach, so no org is disclosed', async () => {
    // DEV_C is not returned by the caller-scoped read.
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
    ]);

    const out = await install();

    expect(out).toEqual({ error: 'orgId is required: you have access to multiple organizations' });
    expect(mockSelect).toHaveBeenCalledTimes(1); // no org-name read
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('keeps the original refusal when a device is outside the caller site scope', async () => {
    nextSelect([
      { id: DEV_A, siteId: 'site-a', orgId: 'org-one' },
      { id: DEV_B, siteId: 'site-forbidden', orgId: 'org-two' },
      { id: DEV_C, siteId: 'site-a', orgId: 'org-one' },
    ]);
    const siteAuth = { ...partnerAuth, allowedSiteIds: ['site-a'], canAccessSite: (s: string | null) => s === 'site-a' };

    const out = JSON.parse(await tool.handler(
      { action: 'install', patchIds: [PATCH], deviceIds: [DEV_A, DEV_B, DEV_C] }, siteAuth));

    expect(out.error).toBe('orgId is required: you have access to multiple organizations');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("orders groups by the caller's device list, not by the read's row order or org id", async () => {
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);
    nextSelect(ORG_NAMES);

    const out = await install({ deviceIds: [DEV_B, DEV_A, DEV_C] });

    expect(out.groups.map((g: { orgId: string; deviceIds: string[] }) => [g.orgId, g.deviceIds])).toEqual([
      ['org-two', [DEV_B]], ['org-one', [DEV_A, DEV_C]],
    ]);
  });

  it('lists a repeated device id once', async () => {
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
    ]);
    nextSelect(ORG_NAMES);

    const out = await install({ deviceIds: [DEV_A, DEV_A, DEV_B] });

    expect(out.groups.map((g: { deviceIds: string[] }) => g.deviceIds)).toEqual([[DEV_A], [DEV_B]]);
  });

  it('keeps the original refusal when a device is outside an exact-device scope', async () => {
    // The read returns DEV_B, but this caller is bound to DEV_A and DEV_C only.
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-two' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);
    const deviceAuth = { ...partnerAuth, allowedDeviceIds: [DEV_A, DEV_C] };

    const out = JSON.parse(await tool.handler(
      { action: 'install', patchIds: [PATCH], deviceIds: [DEV_A, DEV_B, DEV_C] }, deviceAuth));

    expect(out).toEqual({ error: 'orgId is required: you have access to multiple organizations' });
    expect(mockSelect).toHaveBeenCalledTimes(1); // no org-name read
  });

  it('keeps the original refusal when the devices all sit in one org', async () => {
    nextSelect([
      { id: DEV_A, siteId: null, orgId: 'org-one' },
      { id: DEV_B, siteId: null, orgId: 'org-one' },
      { id: DEV_C, siteId: null, orgId: 'org-one' },
    ]);

    const out = await install();

    expect(out.error).toBe('orgId is required: you have access to multiple organizations');
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps the original refusal and reports it when the device-org lookup fails', async () => {
    nextSelect(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await install({ orgId: undefined });
      expect(out.error).toBe('orgId is required: you have access to multiple organizations');
      expect(captureExceptionMock).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('runs no extra read when the install succeeds in one org', async () => {
    nextSelect([{ id: DEV_A, siteId: null }, { id: DEV_B, siteId: null }, { id: DEV_C, siteId: null }]);
    const values = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'job-1' }]) }));
    mockInsert.mockReturnValueOnce({ values });

    const out = await install({ orgId: 'org-one' });

    expect(out.success).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-one' }));
  });
});

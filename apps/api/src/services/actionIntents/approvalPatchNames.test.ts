/**
 * The org pin, the caller's reach and the title hygiene on the approval
 * headline's patch-name read.
 *
 * `resolveApprovalPatchNames` runs under `withSystemDbAccessContext` (RLS
 * bypassed) and reads `patches`, a GLOBAL table with no tenant column, whose
 * `title` is first-writer-wins from ANY tenant's agent. What keeps it from
 * being a cross-tenant oracle is the join through `device_patches` pinned to
 * the intent's org, the call's devices and the call's patches. The
 * `intentService.test.ts` harness discards the `where(...)` argument, so this
 * suite asserts on the BOUND PARAMETERS of the condition handed to `where()`,
 * built by the real `drizzle-orm`, as approvalDeviceName.test.ts does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id: string; title: string | null; externalId: string | null };

const dbState = {
  /** Every condition object handed to `.where()`, in call order. */
  whereArgs: [] as unknown[],
  /** Every table handed to `.from()`. */
  fromArgs: [] as unknown[],
  /** Rows the next `.limit()` resolves to. */
  rows: [] as Row[],
  /** When set, `.limit()` rejects with this: the "never fatal" path. */
  failWith: null as Error | null,
  systemContextLabels: [] as Array<string | undefined>,
  outsideContextCalls: 0,
  /** Is a system context open right now? The site check must run inside one. */
  inSystemContext: false,
};

vi.mock('../../db', () => ({
  db: {
    selectDistinct: () => ({
      from: (table: unknown) => {
        dbState.fromArgs.push(table);
        return {
          innerJoin: () => ({
            where: (condition: unknown) => {
              dbState.whereArgs.push(condition);
              return {
                limit: async () => {
                  if (dbState.failWith) throw dbState.failWith;
                  return dbState.rows;
                },
              };
            },
          }),
        };
      },
    }),
  },
  runOutsideDbContext: <T,>(fn: () => Promise<T>) => {
    dbState.outsideContextCalls += 1;
    return fn();
  },
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>, label?: string) => {
    dbState.systemContextLabels.push(label);
    dbState.inSystemContext = true;
    try {
      return await fn();
    } finally {
      dbState.inSystemContext = false;
    }
  },
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (e: unknown) => captureException(e) }));

const siteScopeContexts: boolean[] = [];
const deviceInSiteScope = vi.fn(async (_auth: unknown, _deviceId: string) => true);
vi.mock('../../routes/tickets/siteScope', () => ({
  deviceInSiteScope: (auth: unknown, deviceId: string) => {
    siteScopeContexts.push(dbState.inSystemContext);
    return deviceInSiteScope(auth, deviceId);
  },
}));

import { and, eq, inArray } from 'drizzle-orm';
import { approvalPatchDisplayName, resolveApprovalPatchNames } from './approvalPatchNames';
import type { ApprovalCallerReach } from './approvalDeviceName';
import { devicePatches } from '../../db/schema/patches';

const ORG_ID = '11111111-2222-4333-8444-555566667777';
const REACH_ORG_ID = '33333333-2222-4333-8444-555566667777';
const DEVICE = '6eae0f70-1111-4222-8333-444455556666';
const OTHER_DEVICE = '7eae0f70-1111-4222-8333-444455556666';
const FOREIGN_DEVICE = '8eae0f70-1111-4222-8333-444455556666';
const PATCH = 'aaaaaaaa-1111-4222-8333-444455556666';
const PATCH_2 = 'bbbbbbbb-1111-4222-8333-444455556666';
const FOREIGN_PATCH = 'cccccccc-1111-4222-8333-444455556666';

function reach(overrides: Partial<ApprovalCallerReach> = {}): ApprovalCallerReach {
  return { orgCondition: (column) => eq(column, REACH_ORG_ID), ...overrides };
}

/**
 * Every value bound as a parameter anywhere inside a drizzle SQL condition.
 * Walks `queryChunks` and plain arrays (an `inArray` list is a nested array
 * of Params), so a dropped term or list entry shows up as a missing value.
 */
function boundParams(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(boundParams);
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) return [obj.value];
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap(boundParams);
  return [];
}

beforeEach(() => {
  dbState.whereArgs = [];
  dbState.fromArgs = [];
  dbState.rows = [];
  dbState.failWith = null;
  dbState.systemContextLabels = [];
  dbState.outsideContextCalls = 0;
  dbState.inSystemContext = false;
  siteScopeContexts.length = 0;
  captureException.mockClear();
  deviceInSiteScope.mockReset();
  deviceInSiteScope.mockResolvedValue(true);
});

describe('boundParams (control for the assertions below)', () => {
  it('sees every entry of an inArray list and every term of an and()', () => {
    // If this helper returned [] for inArray, "ids outside the lists are never
    // read" below would pass vacuously.
    const condition = and(eq(devicePatches.orgId, ORG_ID), inArray(devicePatches.patchId, [PATCH, PATCH_2]));
    expect(boundParams(condition)).toEqual(expect.arrayContaining([ORG_ID, PATCH, PATCH_2]));
    expect(boundParams(inArray(devicePatches.patchId, [PATCH]))).not.toContain(PATCH_2);
    expect(boundParams(inArray(devicePatches.patchId, [PATCH]))).not.toContain(ORG_ID);
  });
});

describe('resolveApprovalPatchNames — the org pin and the id lists', () => {
  it('reads through device_patches, pinned to the org, the call\'s devices, the call\'s patches and the caller\'s reach', async () => {
    dbState.rows = [{ id: PATCH, title: 'Cumulative Update', externalId: 'KB5034441' }];

    await resolveApprovalPatchNames([PATCH, PATCH_2], [DEVICE, OTHER_DEVICE], ORG_ID, reach());

    expect(dbState.fromArgs).toEqual([devicePatches]);
    expect(dbState.whereArgs).toHaveLength(1);
    const params = boundParams(dbState.whereArgs[0]);
    // patches is global: without the org term this read would name any
    // tenant's catalogue row.
    expect(params).toContain(ORG_ID);
    expect(params).toContain(REACH_ORG_ID);
    expect(params).toEqual(expect.arrayContaining([DEVICE, OTHER_DEVICE, PATCH, PATCH_2]));
  });

  it('never reads an id the arguments do not name', async () => {
    await resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, reach());

    const params = boundParams(dbState.whereArgs[0]);
    expect(params).not.toContain(FOREIGN_PATCH);
    expect(params).not.toContain(FOREIGN_DEVICE);
    expect(params).not.toContain(PATCH_2);
    expect(params).not.toContain(OTHER_DEVICE);
  });

  it('drops ids that are not UUIDs, so a malformed argument can never raise 22P02', async () => {
    dbState.rows = [{ id: PATCH, title: 'x', externalId: 'KB5034441' }];

    await resolveApprovalPatchNames([PATCH, 'not-a-uuid', 42, `${PATCH_2} OR 1=1`], [DEVICE, '', null], ORG_ID, reach());

    const params = boundParams(dbState.whereArgs[0]);
    expect(params).not.toContain('not-a-uuid');
    expect(params).not.toContain(42);
    expect(params).not.toContain(`${PATCH_2} OR 1=1`);
    expect(params).not.toContain('');
    expect(params).toEqual(expect.arrayContaining([PATCH, DEVICE]));
  });

  it('bounds each id list to 50', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`);

    await resolveApprovalPatchNames(many, many, ORG_ID, reach());

    const params = boundParams(dbState.whereArgs[0]);
    expect(params).toContain(many[49]);
    expect(params).not.toContain(many[50]);
  });

  it('reads nothing when no id is usable', async () => {
    await expect(resolveApprovalPatchNames(['nope'], [DEVICE], ORG_ID, reach())).resolves.toBeNull();
    await expect(resolveApprovalPatchNames([PATCH], undefined, ORG_ID, reach())).resolves.toBeNull();
    expect(dbState.whereArgs).toHaveLength(0);
  });

  it('reads under a system context opened outside any ambient one', async () => {
    await resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, reach());

    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextLabels).toEqual(['actionIntents.approvalPatchNames']);
  });

  it('names patches in argument order, once each, whatever order the rows come back in', async () => {
    dbState.rows = [
      { id: PATCH_2, title: 'Second', externalId: 'KB5000002' },
      { id: PATCH, title: 'First', externalId: 'KB5000001' },
      { id: PATCH_2, title: 'Second', externalId: 'KB5000002' },
    ];

    await expect(resolveApprovalPatchNames([PATCH, PATCH_2, PATCH], [DEVICE], ORG_ID, reach()))
      .resolves.toEqual(['KB5000001', 'KB5000002']);
  });

  it('resolves to nothing when the org pin matches no row', async () => {
    dbState.rows = [];
    await expect(resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, reach())).resolves.toBeNull();
  });
});

describe('resolveApprovalPatchNames — the caller\'s reach', () => {
  it('returns null with no read when the filing principal carries no org reach', async () => {
    const noReach = {} as unknown as ApprovalCallerReach;
    dbState.rows = [{ id: PATCH, title: 'x', externalId: 'KB5034441' }];

    await expect(resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, noReach)).resolves.toBeNull();
    expect(dbState.whereArgs).toHaveLength(0);
    expect(dbState.systemContextLabels).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('returns null with no patch read when every device is outside the caller\'s site scope', async () => {
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    dbState.rows = [{ id: PATCH, title: 'x', externalId: 'KB5034441' }];
    deviceInSiteScope.mockResolvedValue(false);

    await expect(resolveApprovalPatchNames([PATCH], [DEVICE, OTHER_DEVICE], ORG_ID, siteRestricted)).resolves.toBeNull();
    expect(deviceInSiteScope).toHaveBeenCalledWith(siteRestricted, DEVICE);
    expect(deviceInSiteScope).toHaveBeenCalledWith(siteRestricted, OTHER_DEVICE);
    expect(dbState.whereArgs).toHaveLength(0);
  });

  it('reads only the devices inside the caller\'s site scope, inside the system context', async () => {
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    deviceInSiteScope.mockImplementation(async (_auth, deviceId) => deviceId === DEVICE);

    await resolveApprovalPatchNames([PATCH], [DEVICE, OTHER_DEVICE], ORG_ID, siteRestricted);

    const params = boundParams(dbState.whereArgs[0]);
    expect(params).toContain(DEVICE);
    expect(params).not.toContain(OTHER_DEVICE);
    // Contextless, its own devices read would see zero rows and fail closed
    // for every site-restricted caller.
    expect(siteScopeContexts).toEqual([true, true]);
  });

  it('skips the site check for an unrestricted caller', async () => {
    await resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, reach());
    expect(deviceInSiteScope).not.toHaveBeenCalled();
  });
});

describe('resolveApprovalPatchNames — never fatal', () => {
  it('reports a failed read and degrades to null instead of throwing', async () => {
    dbState.failWith = new Error('connection terminated');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(resolveApprovalPatchNames([PATCH], [DEVICE], ORG_ID, reach())).resolves.toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe('approvalPatchDisplayName — titles are untrusted', () => {
  it('prefers a KB number from external_id', () => {
    expect(approvalPatchDisplayName({ title: 'Security update "KB9999999" on KIT', externalId: 'kb5034441' })).toBe('KB5034441');
  });

  it('falls back to a KB number in the title', () => {
    expect(approvalPatchDisplayName({ title: '2024-01 Cumulative Update (KB5034441)', externalId: 'com.vendor.thing' }))
      .toBe('KB5034441');
  });

  it('quotes a plain title so it reads as data', () => {
    expect(approvalPatchDisplayName({ title: 'Google Chrome 120.0.6099', externalId: 'google-chrome' }))
      .toBe('"Google Chrome 120.0.6099"');
  });

  it('strips newlines and control characters, collapses whitespace, neutralizes quotes and stubs, and caps the length', () => {
    const hostile = `Harmless\r\n\u0007update‮evil​ "quoted" on KIT on device 6eae0f70... ${'A'.repeat(500)}`;
    const name = approvalPatchDisplayName({ title: hostile, externalId: 'x' })!;

    expect(name.startsWith('"') && name.endsWith('"')).toBe(true);
    const inner = name.slice(1, -1);
    expect(inner).not.toMatch(/[\r\n\u0000-\u001f\u007f‮​"]/);
    expect(inner).not.toContain('...');
    expect(inner).not.toMatch(/\s{2}/);
    expect(Array.from(inner).length).toBeLessThanOrEqual(60);
    expect(inner.endsWith('…')).toBe(true);
    expect(inner.startsWith('Harmless update evil ')).toBe(true);
  });

  it('gives nothing for an empty or whitespace-only title with no KB', () => {
    expect(approvalPatchDisplayName({ title: ' \n\t ', externalId: 'x' })).toBeNull();
    expect(approvalPatchDisplayName({ title: null, externalId: null })).toBeNull();
  });
});

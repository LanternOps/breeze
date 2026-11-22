/**
 * #5363 — the org pin on the approval-headline device read.
 *
 * `resolveApprovalDeviceName` deliberately runs under
 * `withSystemDbAccessContext`, i.e. with RLS bypassed, because
 * `createActionIntent` is called from a contextless stack. The ONLY thing
 * standing between that and a cross-tenant hostname oracle is the
 * `eq(devices.orgId, orgId)` term in its WHERE clause — the device id it
 * resolves comes from attacker-supplied tool ARGUMENTS.
 *
 * The `intentService.test.ts` harness cannot protect that term: its Drizzle
 * mock keys canned rows off the TABLE and discards the `where(...)` argument
 * entirely, so the behavioural tests over there would stay green if the org
 * pin were deleted. This suite therefore asserts on the BOUND PARAMETERS of
 * the condition actually handed to `where()`, built by the real `drizzle-orm`
 * `and`/`eq` — the repo's standing rule for guarding a query's shape (see
 * memory `drizzle_condition_deep_search_matches_enum_values_vacuous.md`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = {
  /** Every condition object handed to `.where()`, in call order. */
  whereArgs: [] as unknown[],
  /** Rows the next `.limit()` resolves to. */
  rows: [] as Array<{ hostname: string; displayName: string | null }>,
  /** When set, `.limit()` rejects with this — the "never fatal" path. */
  failWith: null as Error | null,
  systemContextLabels: [] as Array<string | undefined>,
  outsideContextCalls: 0,
};

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
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
    }),
  },
  runOutsideDbContext: <T,>(fn: () => Promise<T>) => {
    dbState.outsideContextCalls += 1;
    return fn();
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>, label?: string) => {
    dbState.systemContextLabels.push(label);
    return fn();
  },
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (e: unknown) => captureException(e) }));

const deviceInSiteScope = vi.fn(async (_auth: unknown, _deviceId: string) => true);
vi.mock('../../routes/tickets/siteScope', () => ({
  deviceInSiteScope: (auth: unknown, deviceId: string) => deviceInSiteScope(auth, deviceId),
}));

import { and, eq } from 'drizzle-orm';
import { argumentDeviceId, resolveApprovalDeviceName, type ApprovalCallerReach } from './approvalDeviceName';
import { buildActionLabel, hasDeviceIdStub } from './actionLabel';
import { checkGuardrails } from '../aiGuardrails';
import { devices } from '../../db/schema/devices';

const DEVICE_ID = '6eae0f70-1111-4222-8333-444455556666';
const ORG_ID = '11111111-2222-4333-8444-555566667777';
const OTHER_ORG_ID = '99999999-2222-4333-8444-555566667777';
const REACH_ORG_ID = '33333333-2222-4333-8444-555566667777';

/** The filing caller's reach. `orgCondition` binds a distinct org id, so its term shows in the bound params. */
function reach(overrides: Partial<ApprovalCallerReach> = {}): ApprovalCallerReach {
  return { orgCondition: (column) => eq(column, REACH_ORG_ID), ...overrides };
}

/**
 * Every value bound as a parameter anywhere inside a drizzle SQL condition.
 * Walks `queryChunks` recursively so a nested `and(eq(...), eq(...))` is
 * flattened — asserting on this is what makes a dropped `eq()` term fail,
 * where asserting on the returned ROWS would not.
 */
function boundParams(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  // A drizzle Param carries its bound value on `.value`.
  if ('value' in obj && 'encoder' in obj) return [obj.value];
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap(boundParams);
  return [];
}

beforeEach(() => {
  dbState.whereArgs = [];
  dbState.rows = [];
  dbState.failWith = null;
  dbState.systemContextLabels = [];
  dbState.outsideContextCalls = 0;
  captureException.mockClear();
  deviceInSiteScope.mockReset();
  deviceInSiteScope.mockResolvedValue(true);
});

describe('resolveApprovalDeviceName — the caller\'s site scope', () => {
  it('cuts the read to the caller\'s org condition', async () => {
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];

    await resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach());

    expect(boundParams(dbState.whereArgs[0])).toContain(REACH_ORG_ID);
  });

  it('resolves to nothing for a device outside the caller\'s site scope', async () => {
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];
    deviceInSiteScope.mockResolvedValueOnce(false);

    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, siteRestricted)).resolves.toBeNull();
    expect(deviceInSiteScope).toHaveBeenCalledWith(siteRestricted, DEVICE_ID);
  });

  it('resolves to nothing for a device outside the caller\'s exact-device ceiling', async () => {
    const deviceBound = reach({ allowedDeviceIds: ['7eae0f70-1111-4222-8333-444455556666'] });
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];
    deviceInSiteScope.mockResolvedValueOnce(false);

    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, deviceBound)).resolves.toBeNull();
    expect(deviceInSiteScope).toHaveBeenCalledWith(deviceBound, DEVICE_ID);
  });

  it('names a device inside the caller\'s site scope', async () => {
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];

    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, siteRestricted)).resolves.toBe('KIT');
    expect(deviceInSiteScope).toHaveBeenCalledTimes(1);
  });

  it('keeps the stub (null, no read, no report) when the filing principal carries no org reach', async () => {
    const noReach = {} as unknown as ApprovalCallerReach;
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];

    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, noReach)).resolves.toBeNull();
    expect(dbState.whereArgs).toHaveLength(0);
    expect(dbState.systemContextLabels).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a site-restricted caller naming an out-of-site device keeps the stub in the stored label', async () => {
    const input = { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' };
    const reason = checkGuardrails('manage_services', input).description!;
    const argDeviceId = argumentDeviceId(input)!;
    expect(hasDeviceIdStub(reason, argDeviceId)).toBe(true);
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];
    deviceInSiteScope.mockResolvedValueOnce(false);

    const name = await resolveApprovalDeviceName(argDeviceId, ORG_ID, reach({ allowedSiteIds: [] }));

    expect(buildActionLabel({ toolName: 'manage_services', input, reason, deviceHostname: name }))
      .toBe('Restart service "Spooler" on device 6eae0f70...');
  });
});

describe('boundParams (control for the assertions below)', () => {
  it('sees both terms of an and(eq, eq) and loses one when a term is dropped', () => {
    // Proves the helper discriminates: if it returned [] for everything, every
    // org-pin assertion in this file would be vacuously satisfiable.
    expect(boundParams(and(eq(devices.id, DEVICE_ID), eq(devices.orgId, ORG_ID))))
      .toEqual(expect.arrayContaining([DEVICE_ID, ORG_ID]));
    expect(boundParams(eq(devices.id, DEVICE_ID))).not.toContain(ORG_ID);
  });
});

describe('resolveApprovalDeviceName — the org pin', () => {
  it('pins the read to BOTH the device id and the intent org', async () => {
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];

    await resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach());

    expect(dbState.whereArgs).toHaveLength(1);
    const params = boundParams(dbState.whereArgs[0]);
    // The device id alone is NOT sufficient: without the org term this read
    // would resolve any tenant's device into an approval headline.
    expect(params).toContain(DEVICE_ID);
    expect(params).toContain(ORG_ID);
    expect(params).not.toContain(OTHER_ORG_ID);
  });

  it('reads under a system context opened outside any ambient one', async () => {
    // A bare system wrapper inside an ambient request context is a
    // passthrough, so dropping runOutsideDbContext would silently read under
    // whatever context the caller happened to hold — or none, returning zero
    // rows and quietly leaving the id stub in the headline.
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];

    await resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach());

    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextLabels).toEqual(['actionIntents.approvalDeviceName']);
  });

  it('prefers the display name over the hostname', async () => {
    dbState.rows = [{ hostname: 'kit', displayName: 'KIT' }];
    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach())).resolves.toBe('KIT');
  });

  it('falls back to the hostname when there is no display name', async () => {
    dbState.rows = [{ hostname: 'kit-01', displayName: null }];
    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach())).resolves.toBe('kit-01');
  });

  it('resolves to nothing when the org pin matches no row', async () => {
    // What a foreign or deleted device id looks like from here: the caller
    // leaves the id stub in place rather than leaking another tenant's name.
    dbState.rows = [];
    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach())).resolves.toBeNull();
  });

  it('reports a failed read to Sentry and degrades to null instead of throwing', async () => {
    // A headline is presentation — an approval that would otherwise be
    // created must not fail because a display-name lookup blipped.
    dbState.failWith = new Error('connection terminated');

    await expect(resolveApprovalDeviceName(DEVICE_ID, ORG_ID, reach())).resolves.toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe('argumentDeviceId', () => {
  it('accepts a canonical uuid argument', () => {
    expect(argumentDeviceId({ deviceId: DEVICE_ID })).toBe(DEVICE_ID);
  });

  it('rejects a non-uuid so a malformed argument can never raise 22P02', () => {
    // devices.id is a Postgres uuid: passing junk would abort the statement
    // and turn a cosmetic lookup into a failed approval.
    for (const bad of ['not-a-uuid', '', '6eae0f70', `${DEVICE_ID} OR 1=1`]) {
      expect(argumentDeviceId({ deviceId: bad })).toBeNull();
    }
    expect(argumentDeviceId({ deviceId: 42 })).toBeNull();
    expect(argumentDeviceId({})).toBeNull();
  });

  it('ignores multi-device arguments, which have no single name to substitute', () => {
    expect(argumentDeviceId({ deviceIds: [DEVICE_ID, '7eae0f70-1111-4222-8333-444455556666'] })).toBeNull();
    expect(argumentDeviceId({ deviceIds: [] })).toBeNull();
  });

  it('names the one device a single-entry deviceIds targets (#11979: run_script on 1 device)', () => {
    expect(argumentDeviceId({ deviceIds: [DEVICE_ID] })).toBe(DEVICE_ID);
    expect(argumentDeviceId({ deviceIds: ['not-a-uuid'] })).toBeNull();
    // The singular argument wins: every other `on device` stub is built from it.
    expect(argumentDeviceId({ deviceId: DEVICE_ID, deviceIds: ['7eae0f70-1111-4222-8333-444455556666'] })).toBe(DEVICE_ID);
  });

  it('chains with the run_script headline so the stored label names the script and the device (#11979)', () => {
    const input = { proposalId: 'aaaaaaaa-1111-4111-8111-111111111111', deviceIds: [DEVICE_ID] };
    const reason = checkGuardrails(
      'run_script', input, { proposal: { riskTier: 'low', strictHits: [], goal: 'Clear the print spooler queue' } },
    ).description!;
    // intentService.ts: resolve the name only when the label carries THIS call's stub.
    const argDeviceId = argumentDeviceId(input);
    expect(argDeviceId).toBe(DEVICE_ID);
    expect(hasDeviceIdStub(reason, argDeviceId!)).toBe(true);
    expect(buildActionLabel({ toolName: 'run_script', input, reason, deviceHostname: 'FRONT-DESK-01' }))
      .toBe('Run proposed script "Clear the print spooler queue" on FRONT-DESK-01');
  });
});

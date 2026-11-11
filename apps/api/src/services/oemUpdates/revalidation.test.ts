import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./toolManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolManifest')>();
  return { ...actual, isCategoryOpen: vi.fn(() => true) };
});

import { commandRevalidations, REVALIDATION_REQUIRED_TYPES } from '../commandClaimEligibility';
import { isCategoryOpen } from './toolManifest';
import { revalidateOemUpdateRun } from './revalidation';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';

const executes: unknown[] = [];
let partnerRows: Array<{ partner_id: string | null }> = [{ partner_id: PARTNER_ID }];
const reader = {
  select: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(async (query: unknown) => {
    executes.push(query);
    return partnerRows;
  }),
} as never;

function row(payload: unknown) {
  return { id: 'c1', type: 'oem_update_run', deviceId: DEVICE_ID, payload };
}

const good = { lane: 'dell', categories: ['driver', 'bios'] };

beforeEach(() => {
  executes.length = 0;
  partnerRows = [{ partner_id: PARTNER_ID }];
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.mocked(isCategoryOpen).mockReset();
  vi.mocked(isCategoryOpen).mockReturnValue(true);
});

afterEach(() => vi.unstubAllEnvs());

describe('revalidateOemUpdateRun (claim-time recheck of an unclaimed run)', () => {
  it('is registered, and required, for the type', () => {
    expect(commandRevalidations.oem_update_run).toBe(revalidateOemUpdateRun);
    expect(REVALIDATION_REQUIRED_TYPES.has('oem_update_run')).toBe(true);
  });

  it('delivers while every lock is still open', async () => {
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBeNull();
    expect(executes).toHaveLength(0);
  });

  it('cancels when its lane kill switch is on', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBe('scope_changed');
  });

  it('a kill switch on another lane does not touch it', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'hp');
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBeNull();
  });

  it('cancels when its gate has closed, whichever category it was', async () => {
    vi.mocked(isCategoryOpen).mockImplementation((_lane, category) => category !== 'bios');
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBe('scope_changed');
    expect(isCategoryOpen).toHaveBeenCalledWith('dell', 'bios', { deviceId: DEVICE_ID });
  });

  it('cancels when the master flag has gone off', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBe('scope_changed');
  });

  it('with an allowlist set, reads the partner on the claim transaction and honours it', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', PARTNER_ID);
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBeNull();
    expect(executes).toHaveLength(1);

    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'someone-else');
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBe('scope_changed');
  });

  it('with an allowlist set, an unresolved partner fails closed', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', PARTNER_ID);
    partnerRows = [];
    await expect(revalidateOemUpdateRun(reader, row(good))).resolves.toBe('scope_changed');
  });

  it.each([
    [null],
    ['text'],
    [{}],
    [{ lane: 'acme', categories: ['driver'] }],
    [{ lane: 'dell' }],
    [{ lane: 'dell', categories: 'driver' }],
    [{ lane: 'dell', categories: [] }],
    [{ lane: 'dell', categories: ['nope'] }],
  ])('fails closed on the unreadable payload %j', async (payload) => {
    await expect(revalidateOemUpdateRun(reader, row(payload))).resolves.toBe('authority_unavailable');
  });
});

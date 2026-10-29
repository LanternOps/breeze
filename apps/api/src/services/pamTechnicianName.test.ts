import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  userRows: [] as Array<{ name: string | null }>,
  select: vi.fn(),
}));

vi.mock('../routes/remote/helpers', async () => {
  const actual = await vi.importActual<typeof import('../routes/remote/helpers')>('../routes/remote/helpers');
  return {
    buildTechnicianDisplay: actual.buildTechnicianDisplay,
    resolveRemoteSessionPromptConfig: mocks.resolveConfig,
  };
});

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      mocks.select(...args);
      return { from: () => ({ where: () => ({ limit: async () => mocks.userRows }) }) };
    },
  },
}));

import { PAM_TECHNICIAN_NAME_MAX, resolvePamTechnicianName } from './pamTechnicianName';

const DEVICE = '30000000-0000-4000-8000-000000000001';
const USER = '60000000-0000-4000-8000-000000000001';

function level(identityLevel: 'name_email' | 'name' | 'generic') {
  mocks.resolveConfig.mockResolvedValue({ identityLevel });
}

describe('resolvePamTechnicianName (#10190 W07, OD-7 (b))', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userRows = [{ name: 'Dana Tech' }];
  });

  it('technicianName null at generic level, and the user is never read', async () => {
    level('generic');
    await expect(resolvePamTechnicianName(DEVICE, { userId: USER })).resolves.toBeNull();
    await expect(resolvePamTechnicianName(DEVICE, { name: 'Dana Tech' })).resolves.toBeNull();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['name', 'name_email'] as const)('returns the name at level %s', async (lvl) => {
    level(lvl);
    await expect(resolvePamTechnicianName(DEVICE, { userId: USER })).resolves.toBe('Dana Tech');
    expect(mocks.resolveConfig).toHaveBeenCalledWith(DEVICE);
  });

  it('email never present: the result is the name only, even at name_email', async () => {
    level('name_email');
    mocks.userRows = [{ name: 'Dana Tech' }];
    const out = await resolvePamTechnicianName(DEVICE, { userId: USER });
    expect(out).toBe('Dana Tech');
    expect(String(out)).not.toContain('@');
  });

  it('uses a caller-supplied name without reading the user', async () => {
    level('name');
    await expect(resolvePamTechnicianName(DEVICE, { name: '  Sam  ' })).resolves.toBe('Sam');
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('null when nobody decided (system expiry, auto approval)', async () => {
    level('name_email');
    await expect(resolvePamTechnicianName(DEVICE, {})).resolves.toBeNull();
    await expect(resolvePamTechnicianName(DEVICE, { userId: null })).resolves.toBeNull();
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
  });

  it('null when the user row is not visible or has a blank name', async () => {
    level('name');
    mocks.userRows = [];
    await expect(resolvePamTechnicianName(DEVICE, { userId: USER })).resolves.toBeNull();
    mocks.userRows = [{ name: '   ' }];
    await expect(resolvePamTechnicianName(DEVICE, { userId: USER })).resolves.toBeNull();
  });

  it('a policy resolution failure is null, never a throw (it must not block an apply or a notify)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.resolveConfig.mockRejectedValue(new Error('policy unreadable'));
    await expect(resolvePamTechnicianName(DEVICE, { userId: USER })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(DEVICE);
    warn.mockRestore();
  });

  it('caps the name at the prompt identity cap in code points', async () => {
    level('name');
    const long = '😀'.repeat(PAM_TECHNICIAN_NAME_MAX + 10);
    const out = await resolvePamTechnicianName(DEVICE, { name: long });
    expect(Array.from(out!)).toHaveLength(PAM_TECHNICIAN_NAME_MAX);
    expect(PAM_TECHNICIAN_NAME_MAX).toBe(120);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  getWispNudgePrefs,
  updateWispNudgePrefs,
  WISP_NUDGE_PREFERENCE_DEFAULTS as DEFAULTS,
} from './wispNudgePrefs';

beforeEach(() => {
  coreRequest.mockReset();
});

const settings = (s: unknown) => ({ data: { settings: s } });

describe('getWispNudgePrefs', () => {
  it('reads the core endpoint and unwraps data.settings', async () => {
    coreRequest.mockResolvedValue(
      settings({ ...DEFAULTS, proactivity: 'chatty', digestCadenceMinutes: 60 })
    );
    await expect(getWispNudgePrefs()).resolves.toEqual({
      ...DEFAULTS, proactivity: 'chatty', digestCadenceMinutes: 60,
    });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/nudge-preferences');
  });

  it('defaults each channel independently', async () => {
    coreRequest.mockResolvedValue(settings({ channels: { push: false } }));
    await expect(getWispNudgePrefs()).resolves.toEqual({
      ...DEFAULTS, channels: { inApp: true, push: false },
    });
  });

  it('defaults everything for an empty or missing body', async () => {
    coreRequest.mockResolvedValue({});
    await expect(getWispNudgePrefs()).resolves.toEqual(DEFAULTS);
  });

  it('keeps an explicit null briefTimeLocal (Off) but defaults a malformed one', async () => {
    coreRequest.mockResolvedValue(settings({ briefTimeLocal: null }));
    expect((await getWispNudgePrefs()).briefTimeLocal).toBeNull();
    coreRequest.mockResolvedValue(settings({ briefTimeLocal: '25:00' }));
    expect((await getWispNudgePrefs()).briefTimeLocal).toBe('08:00');
    coreRequest.mockResolvedValue(settings({ briefTimeLocal: '07:30' }));
    expect((await getWispNudgePrefs()).briefTimeLocal).toBe('07:30');
    coreRequest.mockResolvedValue(settings({ briefTimeLocal: 730 }));
    expect((await getWispNudgePrefs()).briefTimeLocal).toBe('08:00');
  });

  it('range-checks cadence and validates enums and timezone', async () => {
    coreRequest.mockResolvedValue(
      settings({ digestCadenceMinutes: 14, quietOverride: 'x', proactivity: 'loud', briefTimezone: '' })
    );
    await expect(getWispNudgePrefs()).resolves.toEqual(DEFAULTS);
    coreRequest.mockResolvedValue(settings({ digestCadenceMinutes: 1441 }));
    expect((await getWispNudgePrefs()).digestCadenceMinutes).toBe(240);
    coreRequest.mockResolvedValue(settings({ digestCadenceMinutes: 30.5 }));
    expect((await getWispNudgePrefs()).digestCadenceMinutes).toBe(240);
    coreRequest.mockResolvedValue(
      settings({ digestCadenceMinutes: 15, quietOverride: 'urgent_only', briefTimezone: 'Europe/Berlin' })
    );
    expect(await getWispNudgePrefs()).toMatchObject({
      digestCadenceMinutes: 15, quietOverride: 'urgent_only', briefTimezone: 'Europe/Berlin',
    });
    coreRequest.mockResolvedValue(settings({ briefTimezone: 'x'.repeat(65) }));
    expect((await getWispNudgePrefs()).briefTimezone).toBeNull();
  });

  it('freezes the defaults', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.channels)).toBe(true);
  });
});

describe('updateWispNudgePrefs', () => {
  it('PUTs only the patch and normalises the echo', async () => {
    coreRequest.mockResolvedValue(settings({ ...DEFAULTS, proactivity: 'quiet' }));
    const out = await updateWispNudgePrefs({ proactivity: 'quiet' });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/nudge-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactivity: 'quiet' }),
    });
    expect(out.proactivity).toBe('quiet');
  });

  it('throws on an empty patch without calling the API', async () => {
    await expect(updateWispNudgePrefs({})).rejects.toThrow();
    expect(coreRequest).not.toHaveBeenCalled();
  });
});

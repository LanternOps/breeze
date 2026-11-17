/**
 * A wake_on_lan link whose stored settings no longer parse resolves as
 * 'verified' (fail closed). It must be observable: console.error AND Sentry,
 * once per bad link per process, not once per device it reaches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

const { captureExceptionMock, candidatesMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  candidatesMock: vi.fn(),
}));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./devicePolicySet', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  policySetFor: vi.fn(() => ({ deviceId: 'dev-1', hierarchy: {}, candidates: [] })),
  candidatesWithLink: candidatesMock,
}));

import { resolveWakeOnLanSettingsForDevice } from './featureConfigResolver';

function badLink(linkId: string) {
  return [{
    candidate: {
      level: 'organization', priority: 1, assignmentCreatedAt: new Date('2026-01-01'), policyId: 'pol-1',
    },
    link: { id: linkId, inlineSettings: { buttonMode: 'nonsense' } },
  }];
}

describe('wake_on_lan unparseable settings', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear();
    candidatesMock.mockReset();
  });

  it('resolves as verified, logs, and reports to Sentry once per bad link', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    candidatesMock.mockReturnValue(badLink('link-bad-1'));

    const first = await resolveWakeOnLanSettingsForDevice('dev-1', {} as never);
    const second = await resolveWakeOnLanSettingsForDevice('dev-1', {} as never);

    expect(first).toEqual({ configureSettings: false, buttonMode: 'verified' });
    expect(second).toEqual(first);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('wake_on_lan') }),
      undefined,
      expect.objectContaining({ linkId: 'link-bad-1' }),
    );

    candidatesMock.mockReturnValue(badLink('link-bad-2'));
    await resolveWakeOnLanSettingsForDevice('dev-1', {} as never);
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});

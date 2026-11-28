import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ coreRequest: vi.fn() }));
import { coreRequest } from './api';
import { createCodeUsableReader, getAuthenticatorCodeUsable } from './authenticatorCodeUsable';

describe('whether the server takes an authenticator code from this account', () => {
  beforeEach(() => {
    vi.mocked(coreRequest).mockReset();
  });

  it.each([
    [true, true],
    [false, false],
  ])('reads totpEnrolled=%s from the signed-in profile', async (totpEnrolled, expected) => {
    vi.mocked(coreRequest).mockResolvedValue({ id: 'u1', totpEnrolled });
    await expect(getAuthenticatorCodeUsable()).resolves.toBe(expected);
    expect(coreRequest).toHaveBeenCalledWith('/users/me');
  });

  it('is unknown when the profile does not say', async () => {
    vi.mocked(coreRequest).mockResolvedValue({ id: 'u1' });
    await expect(getAuthenticatorCodeUsable()).resolves.toBeUndefined();
  });

  it('is unknown when the profile cannot be read', async () => {
    vi.mocked(coreRequest).mockRejectedValue(new Error('network'));
    await expect(getAuthenticatorCodeUsable()).resolves.toBeUndefined();
  });
});

describe('the approval screen keeps a definite answer and asks again after an unknown one', () => {
  it('keeps a definite answer: the profile is read once', async () => {
    const read = vi.fn(async () => false as boolean | undefined);
    const usable = createCodeUsableReader(read);
    await expect(usable()).resolves.toBe(false);
    await expect(usable()).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('asks again after an unknown answer', async () => {
    const read = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    const usable = createCodeUsableReader(read);
    await expect(usable()).resolves.toBeUndefined();
    await expect(usable()).resolves.toBe(true);
    await expect(usable()).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

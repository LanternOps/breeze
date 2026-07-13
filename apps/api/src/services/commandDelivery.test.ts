import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';

const releaseClaimedCommandDeliveryMock = vi.fn(async () => undefined);
vi.mock('./commandDispatch', () => ({
  releaseClaimedCommandDelivery: (...args: unknown[]) =>
    releaseClaimedCommandDeliveryMock(...(args as [])),
}));

const captureExceptionMock = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

import { decryptClaimedCommandsForDelivery } from './commandDelivery';
import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';

const claimedAt = new Date('2026-07-13T00:00:00Z');

// A well-formed-looking but undecryptable sensitive payload (e.g. after an
// APP_ENCRYPTION_KEY rotation).
const undecryptable = {
  id: 'cmd-bad',
  type: 'encryption_rotate_key',
  payload: { password: 'enc:v3:deadbeef:not-real-ciphertext' },
  executedAt: claimedAt,
};

describe('decryptClaimedCommandsForDelivery (#2414)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases a command that fails decryption back to pending while its siblings still deliver', async () => {
    const goodEncrypted = encryptSensitivePayloadFields('encryption_rotate_key', { password: 'pw' });
    const claimed = [
      { id: 'cmd-plain', type: 'run_script', payload: { scriptId: 's-1' }, executedAt: claimedAt },
      { id: 'cmd-good', type: 'encryption_rotate_key', payload: goodEncrypted, executedAt: claimedAt },
      undecryptable,
    ];

    const delivered = await decryptClaimedCommandsForDelivery(claimed);

    expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain', 'cmd-good']);
    expect((delivered[1]?.payload as Record<string, unknown> | undefined)?.password).toBe('pw');
    // The undecryptable command must go back to pending — not strand as sent.
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledTimes(1);
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-bad', claimedAt);
    // Loud: the decrypt failure is reported to Sentry with commandId/type context.
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('commandId=cmd-bad'),
      }),
    );
  });

  it('does not touch the release path when every command decrypts', async () => {
    const delivered = await decryptClaimedCommandsForDelivery([
      { id: 'cmd-1', type: 'run_script', payload: { scriptId: 's-1' }, executedAt: claimedAt },
    ]);

    expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-1']);
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('still returns the deliverable siblings (and captures) when the release itself fails', async () => {
    releaseClaimedCommandDeliveryMock.mockRejectedValueOnce(new Error('db down'));

    const delivered = await decryptClaimedCommandsForDelivery([
      { id: 'cmd-plain', type: 'run_script', payload: {}, executedAt: claimedAt },
      undecryptable,
    ]);

    expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain']);
    // Two captures: the decrypt failure (chokepoint) + the failed release.
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('release of undeliverable claimed command failed (commandId=cmd-bad'),
      }),
    );
  });

  it('captures instead of releasing when a failed row is missing its claim timestamp', async () => {
    const delivered = await decryptClaimedCommandsForDelivery([
      { ...undecryptable, executedAt: null },
    ]);

    expect(delivered).toEqual([]);
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('cannot release'),
      }),
    );
  });

  it('returns an empty array for an empty batch', async () => {
    await expect(decryptClaimedCommandsForDelivery([])).resolves.toEqual([]);
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
  });
});

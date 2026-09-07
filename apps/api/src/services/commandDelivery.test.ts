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

// #3409 PR4c-2 — the claim gate. Mocked here (it has its own DB-level suite in
// scriptSecretDelivery.test.ts); these tests assert the WIRING: it runs before
// any decryption, and only what it returns is decrypted and released.
const failClaimedSecretCommandsMock = vi.fn(async (claimed: unknown[]) => claimed);
vi.mock('./scriptSecretDelivery', () => ({
  failClaimedSecretCommandsForUnsupportedAgent: (...args: unknown[]) =>
    failClaimedSecretCommandsMock(...(args as [any])),
}));

import {
  decryptClaimedCommandsForDelivery,
  deliveryRefreshers,
  prepareClaimedCommandsForDelivery,
  refreshPayloadForDelivery,
} from './commandDelivery';
import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';

const CLAIM_DEVICE = '99999999-9999-4999-8999-999999999999';

const claimedAt = new Date('2026-07-13T00:00:00Z');

// A well-formed-looking but undecryptable sensitive payload (e.g. after an
// APP_ENCRYPTION_KEY rotation).
const undecryptable = {
  id: 'cmd-bad',
  type: 'encryption_rotate_key',
  deviceId: CLAIM_DEVICE,
  payload: { password: 'enc:v3:deadbeef:not-real-ciphertext' },
  executedAt: claimedAt,
};

describe('decryptClaimedCommandsForDelivery (#2414)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failClaimedSecretCommandsMock.mockImplementation(async (claimed: unknown[]) => claimed);
  });

  it('releases a command that fails decryption back to pending while its siblings still deliver', async () => {
    const goodEncrypted = encryptSensitivePayloadFields('encryption_rotate_key', { password: 'pw' });
    const claimed = [
      { id: 'cmd-plain', type: 'run_script', deviceId: CLAIM_DEVICE, payload: { scriptId: 's-1' }, executedAt: claimedAt },
      { id: 'cmd-good', type: 'encryption_rotate_key', deviceId: CLAIM_DEVICE, payload: goodEncrypted, executedAt: claimedAt },
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
      { id: 'cmd-1', type: 'run_script', deviceId: CLAIM_DEVICE, payload: { scriptId: 's-1' }, executedAt: claimedAt },
    ]);

    expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-1']);
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('still returns the deliverable siblings (and captures) when the release itself fails', async () => {
    releaseClaimedCommandDeliveryMock.mockRejectedValueOnce(new Error('db down'));

    const delivered = await decryptClaimedCommandsForDelivery([
      { id: 'cmd-plain', type: 'run_script', deviceId: CLAIM_DEVICE, payload: {}, executedAt: claimedAt },
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

  // ── #3409 PR4c-2: the secret-delivery claim gate ───────────────────

  describe('secret-delivery claim gate', () => {
    const secretCommand = {
      id: 'cmd-secret',
      type: 'script',
      deviceId: CLAIM_DEVICE,
      payload: { scriptId: 's-secret', secretEnvEnvelope: 'enc:v3:key-1:ciphertext' },
      executedAt: claimedAt,
    };
    const plainCommand = {
      id: 'cmd-plain',
      type: 'run_script',
      deviceId: CLAIM_DEVICE,
      payload: { scriptId: 's-1' },
      executedAt: claimedAt,
    };

    it('runs the gate on the claimed batch BEFORE anything is decrypted', async () => {
      const goodEncrypted = encryptSensitivePayloadFields('encryption_rotate_key', { password: 'pw' });
      const claimed = [
        plainCommand,
        { id: 'cmd-good', type: 'encryption_rotate_key', deviceId: CLAIM_DEVICE, payload: goodEncrypted, executedAt: claimedAt },
      ];

      const delivered = await decryptClaimedCommandsForDelivery(claimed);

      expect(failClaimedSecretCommandsMock).toHaveBeenCalledTimes(1);
      // Called with the RAW claimed rows — still sealed, never the decrypted
      // ones (the gate must never see plaintext). #5128 relaxed this from
      // reference identity to structural equality: the delivery-refresher pass
      // now runs first and rebuilds the array (payload contents are untouched
      // for every type without a registered refresher), so identity is no
      // longer meaningful. What matters — sealed, not plaintext — still holds.
      expect(failClaimedSecretCommandsMock.mock.calls[0]![0]).toStrictEqual(claimed);
      expect((claimed[1]!.payload as Record<string, unknown>).password).toBe(goodEncrypted.password);
      expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain', 'cmd-good']);
    });

    it('decrypts and delivers ONLY what the gate returned', async () => {
      failClaimedSecretCommandsMock.mockResolvedValueOnce([plainCommand]);

      const delivered = await decryptClaimedCommandsForDelivery([plainCommand, secretCommand]);

      expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain']);
    });

    it('does NOT release a withheld command back to pending — it is terminal', async () => {
      // The gate already drove `cmd-secret` to `failed` with its payload
      // erased; releasing it would hand it straight back to the same
      // incapable agent on the next claim.
      failClaimedSecretCommandsMock.mockResolvedValueOnce([plainCommand]);

      const delivered = await decryptClaimedCommandsForDelivery([plainCommand, secretCommand]);

      expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain']);
      expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('still releases a DECRYPT failure among the gate survivors (#2414 is unaffected)', async () => {
      failClaimedSecretCommandsMock.mockResolvedValueOnce([plainCommand, undecryptable]);

      const delivered = await decryptClaimedCommandsForDelivery([plainCommand, undecryptable, secretCommand]);

      expect(delivered.map((cmd) => cmd.id)).toEqual(['cmd-plain']);
      expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledTimes(1);
      expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-bad', claimedAt);
    });

    it('threads a caller-reported capability through to the gate as authoritative', async () => {
      await decryptClaimedCommandsForDelivery([secretCommand], { reportedScriptSecretEnvVersion: 0 });
      expect(failClaimedSecretCommandsMock).toHaveBeenCalledWith([secretCommand], { reportedVersion: 0 });
    });

    it('passes no reported version when the caller has none (stored-column fallback)', async () => {
      await decryptClaimedCommandsForDelivery([secretCommand]);
      expect(failClaimedSecretCommandsMock).toHaveBeenCalledWith([secretCommand], {});
    });

    it('propagates a gate contract violation instead of delivering the batch', async () => {
      // The gate throws on a misuse it cannot safely resolve (e.g. one
      // agent's self-reported capability handed to a multi-device batch).
      // Delivery must fail loudly: nothing decrypted, nothing released, and
      // no sealed secret shipped on the strength of another device's report.
      failClaimedSecretCommandsMock.mockRejectedValueOnce(new Error('reportedVersion contract violation'));

      await expect(
        decryptClaimedCommandsForDelivery([plainCommand, secretCommand], {
          reportedScriptSecretEnvVersion: 1,
        }),
      ).rejects.toThrow('reportedVersion contract violation');

      expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    });
  });
});

describe('late-binding delivery preparation (#5128 §D / OD-8)', () => {
  const original = { ...deliveryRefreshers };

  beforeEach(() => {
    vi.clearAllMocks();
    failClaimedSecretCommandsMock.mockImplementation(async (claimed: unknown[]) => claimed);
    for (const key of Object.keys(deliveryRefreshers)) delete deliveryRefreshers[key];
    Object.assign(deliveryRefreshers, original);
  });

  it('ships a software_install refresher out of the box, so no import order can silence it', () => {
    // Registering by side effect from the owning feature module would deliver a
    // stale installer URL in any process that happened not to import it.
    expect(typeof deliveryRefreshers.software_install).toBe('function');
  });

  it('runs the per-type refresher before decrypt so time-limited fields are fresh at delivery', async () => {
    deliveryRefreshers.software_install = async (p) => ({
      ...p,
      downloadUrl: 'https://fresh.example/installer',
    });

    const out = await prepareClaimedCommandsForDelivery([
      {
        id: 'cmd-sw',
        type: 'software_install',
        deviceId: CLAIM_DEVICE,
        payload: { s3Key: 'k', downloadUrl: 'https://stale.example' },
        executedAt: claimedAt,
      },
    ]);

    expect(out).toHaveLength(1);
    expect((out[0]!.payload as Record<string, unknown>).downloadUrl).toBe(
      'https://fresh.example/installer',
    );
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
  });

  it('a refresher failure releases the row instead of delivering a stale payload', async () => {
    deliveryRefreshers.software_install = async () => {
      throw new Error('presign down');
    };

    const out = await prepareClaimedCommandsForDelivery([
      {
        id: 'cmd-sw',
        type: 'software_install',
        deviceId: CLAIM_DEVICE,
        payload: { s3Key: 'k', downloadUrl: 'https://stale.example' },
        executedAt: claimedAt,
      },
    ]);

    expect(out).toEqual([]);
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-sw', claimedAt);
  });

  it('a refresher failure never sinks its siblings in the same batch', async () => {
    deliveryRefreshers.software_install = async () => {
      throw new Error('presign down');
    };

    const out = await prepareClaimedCommandsForDelivery([
      { id: 'cmd-plain', type: 'script', deviceId: CLAIM_DEVICE, payload: { a: 1 }, executedAt: claimedAt },
      { id: 'cmd-sw', type: 'software_install', deviceId: CLAIM_DEVICE, payload: {}, executedAt: claimedAt },
    ]);

    expect(out.map((cmd) => cmd.id)).toEqual(['cmd-plain']);
  });

  it('a type with no registered refresher passes through untouched', async () => {
    const out = await prepareClaimedCommandsForDelivery([
      { id: 'cmd-plain', type: 'script', deviceId: CLAIM_DEVICE, payload: { a: 1 }, executedAt: claimedAt },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toEqual({ a: 1 });
  });

  it('a non-object payload is handed to the refresher as an empty object, not crashed on', async () => {
    const seen: unknown[] = [];
    deliveryRefreshers.software_install = async (p) => {
      seen.push(p);
      return p;
    };

    await prepareClaimedCommandsForDelivery([
      { id: 'cmd-sw', type: 'software_install', deviceId: CLAIM_DEVICE, payload: null, executedAt: claimedAt },
      { id: 'cmd-sw2', type: 'software_install', deviceId: CLAIM_DEVICE, payload: [1, 2], executedAt: claimedAt },
    ]);

    expect(seen).toEqual([{}, {}]);
  });

  it('refreshPayloadForDelivery returns null on failure so the single-push path can release', async () => {
    deliveryRefreshers.software_install = async () => {
      throw new Error('presign down');
    };
    await expect(refreshPayloadForDelivery('software_install', { s3Key: 'k' })).resolves.toBeNull();
    await expect(refreshPayloadForDelivery('script', { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it('decryptClaimedCommandsForDelivery is still exported as an alias of the new name', () => {
    expect(decryptClaimedCommandsForDelivery).toBe(prepareClaimedCommandsForDelivery);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  HUNTRESS_WEBHOOK_DEDUPE_TTL_SECONDS,
  huntressWebhookReplayKey,
  releaseHuntressWebhookMessage,
  reserveHuntressWebhookMessage,
} from './huntressWebhookReplay';
import { HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS } from './huntressWebhookSignature';

const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const MSG_ID = 'msg_2pHuntressDelivery';

describe('huntress webhook replay reservation', () => {
  it('keeps a reservation at least as long as the signature replay window', () => {
    expect(HUNTRESS_WEBHOOK_DEDUPE_TTL_SECONDS).toBeGreaterThanOrEqual(HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS);
  });

  it('scopes the key to the integration and the webhook-id', () => {
    expect(huntressWebhookReplayKey(INTEGRATION_ID, MSG_ID)).toBe(`huntress:webhook:${INTEGRATION_ID}:${MSG_ID}`);
  });

  it('reserves with SET NX and the dedupe TTL', async () => {
    const redis = { set: vi.fn(async () => 'OK' as const), del: vi.fn() };
    const result = await reserveHuntressWebhookMessage(redis as never, INTEGRATION_ID, MSG_ID);
    expect(result).toEqual({ status: 'reserved', key: huntressWebhookReplayKey(INTEGRATION_ID, MSG_ID) });
    expect(redis.set).toHaveBeenCalledWith(
      huntressWebhookReplayKey(INTEGRATION_ID, MSG_ID),
      '1',
      'EX',
      HUNTRESS_WEBHOOK_DEDUPE_TTL_SECONDS,
      'NX',
    );
  });

  it('reports a duplicate when the id is already reserved', async () => {
    const redis = { set: vi.fn(async () => null), del: vi.fn() };
    expect(await reserveHuntressWebhookMessage(redis as never, INTEGRATION_ID, MSG_ID)).toEqual({ status: 'duplicate' });
  });

  it('reports unavailable when there is no Redis client', async () => {
    expect(await reserveHuntressWebhookMessage(null, INTEGRATION_ID, MSG_ID)).toEqual({ status: 'unavailable' });
  });

  it('reports unavailable, without throwing, when SET fails', async () => {
    const redis = { set: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), del: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await reserveHuntressWebhookMessage(redis as never, INTEGRATION_ID, MSG_ID)).toEqual({ status: 'unavailable' });
    } finally {
      error.mockRestore();
    }
  });

  it('releases by deleting the key, and swallows a failed delete', async () => {
    const key = huntressWebhookReplayKey(INTEGRATION_ID, MSG_ID);
    const ok = { set: vi.fn(), del: vi.fn(async () => 1) };
    await releaseHuntressWebhookMessage(ok as never, key);
    expect(ok.del).toHaveBeenCalledWith(key);

    const failing = { set: vi.fn(), del: vi.fn(async () => { throw new Error('ECONNRESET'); }) };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(releaseHuntressWebhookMessage(failing as never, key)).resolves.toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });
});

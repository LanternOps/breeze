/**
 * #10428 (W05) — the capture status the chip polls: owner-stamped, and only
 * `pending` ever moves to a terminal status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map<string, string>(), redisUp: true }));

vi.mock('../redis', () => ({
  getRedis: () => (h.redisUp
    ? {
      set: vi.fn(async (key: string, value: string) => { h.store.set(key, value); return 'OK'; }),
      get: vi.fn(async (key: string) => h.store.get(key) ?? null),
    }
    : null),
}));

import {
  beginInstructionCapture,
  finishInstructionCapture,
  instructionCaptureStatusKey,
  readInstructionCapture,
} from './instructionCaptureStatus';

beforeEach(() => {
  h.store.clear();
  h.redisUp = true;
});

describe('instruction capture status', () => {
  it('begins pending with its owner, then records the outcome', async () => {
    await expect(beginInstructionCapture({ captureId: 'c-1', userId: 'u-1', sessionId: 's-1' })).resolves.toBe(true);
    expect(await readInstructionCapture('c-1')).toEqual({ status: 'pending', userId: 'u-1', sessionId: 's-1' });
    await finishInstructionCapture('c-1', 'saved');
    expect(await readInstructionCapture('c-1')).toEqual({ status: 'saved', userId: 'u-1', sessionId: 's-1' });
  });

  it('a terminal status is final', async () => {
    await beginInstructionCapture({ captureId: 'c-1', userId: 'u-1', sessionId: 's-1' });
    await finishInstructionCapture('c-1', 'saved');
    await finishInstructionCapture('c-1', 'failed');
    expect((await readInstructionCapture('c-1'))?.status).toBe('saved');
  });

  it('an unknown or expired capture stays unknown', async () => {
    await finishInstructionCapture('c-9', 'failed');
    expect(await readInstructionCapture('c-9')).toBeNull();
  });

  it('a malformed value reads as unknown', async () => {
    h.store.set(instructionCaptureStatusKey('c-1'), '{"s":"weird","u":"u-1","sid":"s-1"}');
    expect(await readInstructionCapture('c-1')).toBeNull();
    h.store.set(instructionCaptureStatusKey('c-2'), 'not json');
    expect(await readInstructionCapture('c-2')).toBeNull();
  });

  it('no Redis: nothing begins and nothing reads', async () => {
    h.redisUp = false;
    await expect(beginInstructionCapture({ captureId: 'c-1', userId: 'u-1', sessionId: 's-1' })).resolves.toBe(false);
    expect(await readInstructionCapture('c-1')).toBeNull();
  });
});

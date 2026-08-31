import { afterEach, describe, expect, it, vi } from 'vitest';

describe('eventDispatchMode', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('defaults to off when unset', async () => {
    vi.stubEnv('EVENT_DISPATCH_MODE', '');
    const { eventDispatchMode } = await import('./env');
    expect(eventDispatchMode()).toBe('off');
  });

  it('parses shadow and enforce', async () => {
    const { eventDispatchMode } = await import('./env');
    vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
    expect(eventDispatchMode()).toBe('shadow');
    vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
    expect(eventDispatchMode()).toBe('enforce');
  });

  it('falls back to off WITH a warning on an unrecognized value (never silently enforce)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('EVENT_DISPATCH_MODE', 'enforced'); // typo
    const { eventDispatchMode } = await import('./env');
    expect(eventDispatchMode()).toBe('off');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_DISPATCH_MODE'));
  });

  it('parses the queue-subscriber csv, trims, drops empties', async () => {
    vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', ' webhook-delivery, notification-dispatcher ,');
    const { eventDispatchQueueSubscribers } = await import('./env');
    expect([...eventDispatchQueueSubscribers()].sort()).toEqual([
      'notification-dispatcher', 'webhook-delivery',
    ]);
  });

  it('ignores unknown ids in the csv with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery,not-a-subscriber');
    const { eventDispatchQueueSubscribers } = await import('./env');
    expect([...eventDispatchQueueSubscribers()]).toEqual(['webhook-delivery']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-subscriber'));
  });
});

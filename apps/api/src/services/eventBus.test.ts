import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('./redis', () => ({
  getRedis: vi.fn()
}));

describe('eventBus service', () => {
  let mockRedis: Partial<Redis>;
  let eventBusModule: typeof import('./eventBus');
  let getRedis: (typeof import('./redis'))['getRedis'];

  beforeEach(async () => {
    vi.resetModules();
    mockRedis = {
      xadd: vi.fn().mockResolvedValue('0-0'),
      publish: vi.fn().mockResolvedValue(1),
      xack: vi.fn().mockResolvedValue(1),
      lpush: vi.fn().mockResolvedValue(1)
    };

    eventBusModule = await import('./eventBus');
    ({ getRedis } = await import('./redis'));
    vi.mocked(getRedis).mockReturnValue(mockRedis as Redis);
  });

  it('should publish events to stream and pubsub channels', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    const eventId = await publishEvent(
      EVENT_TYPES.DEVICE_ENROLLED,
      'org-1',
      { deviceId: 'dev-1' },
      'unit-test'
    );

    expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
    const xaddMock = mockRedis.xadd as ReturnType<typeof vi.fn>;
    const xaddArgs = xaddMock.mock.calls[0];
    const eventJson = xaddArgs[xaddArgs.length - 1] as string;
    const event = JSON.parse(eventJson) as { id: string; metadata: { correlationId: string } };

    expect(event.id).toBe(eventId);
    expect(event.metadata.correlationId).toBe(eventId);
    expect(event.type).toBe(EVENT_TYPES.DEVICE_ENROLLED);
    expect(event.orgId).toBe('org-1');
    expect(event.source).toBe('unit-test');
    expect(event.priority).toBe('normal');
    expect(event.payload).toEqual({ deviceId: 'dev-1' });
    expect(event.metadata.timestamp).toEqual(expect.any(String));

    expect(mockRedis.publish).toHaveBeenCalledWith(
      'breeze:events:live:org-1',
      eventJson
    );
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'breeze:events:global',
      eventJson
    );
  });

  it('should invoke subscribed handlers and acknowledge the message', async () => {
    const { getEventBus, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);

    const event = {
      id: 'evt-1',
      type: EVENT_TYPES.DEVICE_ENROLLED,
      orgId: 'org-1',
      source: 'unit-test',
      priority: 'normal',
      payload: { deviceId: 'dev-1' },
      metadata: {
        timestamp: new Date().toISOString()
      }
    };

    await (bus as any).processMessage(
      '123-0',
      ['event', JSON.stringify(event)],
      mockRedis as Redis
    );

    expect(handler).toHaveBeenCalledWith(event);
    expect(mockRedis.xack).toHaveBeenCalledWith(
      'breeze:events:org-1',
      'breeze-api',
      '123-0'
    );
  });

  it('should unsubscribe handlers', async () => {
    const { getEventBus, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    const unsubscribe = bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);
    unsubscribe();

    const event = {
      id: 'evt-2',
      type: EVENT_TYPES.DEVICE_ENROLLED,
      orgId: 'org-1',
      source: 'unit-test',
      priority: 'normal',
      payload: { deviceId: 'dev-2' },
      metadata: {
        timestamp: new Date().toISOString()
      }
    };

    await (bus as any).processMessage(
      '124-0',
      ['event', JSON.stringify(event)],
      mockRedis as Redis
    );

    expect(handler).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith(
      'breeze:events:org-1',
      'breeze-api',
      '124-0'
    );
  });
});

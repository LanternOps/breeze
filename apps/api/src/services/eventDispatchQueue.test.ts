import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BreezeEvent, EventType } from './eventBus';

const queueAdd = vi.fn().mockResolvedValue(undefined);
const queueClose = vi.fn().mockResolvedValue(undefined);
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: queueAdd,
    close: queueClose,
  })),
}));

// `recordShadowLocalInvocation` coalesces HINCRBY + HSET + EXPIRE into ONE
// `multi()` pipeline (final-review cost trim, #4085) rather than three
// separately-awaited commands. The pipeline mock records each queued command
// via these spies and resolves/rejects on `.exec()`.
const pipelineHincrby = vi.fn();
const pipelineHset = vi.fn();
const pipelineExpire = vi.fn();
const pipelineExec = vi.fn().mockResolvedValue([]);
const redisMulti = vi.fn(() => {
  const pipeline = {
    hincrby: (...args: unknown[]) => {
      pipelineHincrby(...args);
      return pipeline;
    },
    hset: (...args: unknown[]) => {
      pipelineHset(...args);
      return pipeline;
    },
    expire: (...args: unknown[]) => {
      pipelineExpire(...args);
      return pipeline;
    },
    exec: pipelineExec,
  };
  return pipeline;
});
vi.mock('./redis', () => ({
  getRedisConnection: vi.fn(() => ({
    multi: redisMulti,
  })),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

function makeEvent(overrides: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'aa000000-0000-4000-8000-000000000000',
    type: 'device.online' as EventType,
    orgId: 'org-1',
    source: 'unit-test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: new Date().toISOString() },
    ...overrides,
  };
}

describe('eventDispatchQueue', () => {
  let mod: typeof import('./eventDispatchQueue');
  let registry: typeof import('./eventSubscriberRegistry');

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    queueAdd.mockClear().mockResolvedValue(undefined);
    queueClose.mockClear().mockResolvedValue(undefined);
    redisMulti.mockClear();
    pipelineHincrby.mockClear();
    pipelineHset.mockClear();
    pipelineExpire.mockClear();
    pipelineExec.mockClear().mockResolvedValue([]);

    mod = await import('./eventDispatchQueue');
    registry = await import('./eventSubscriberRegistry');
    registry._resetEventSubscriberRegistryForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports the queue name constant', () => {
    expect(mod.EVENT_DISPATCH_QUEUE).toBe('event-dispatch');
  });

  describe('enqueueRouteEvent', () => {
    it('mode off: adds nothing', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'off');
      await mod.enqueueRouteEvent(makeEvent());
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('mode shadow: one route-event add with jobId, queueSubscriberIds === matchedSubscriberIds', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      registry.registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: ['device.online'],
        handler: async () => {},
      });
      registry.registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: ['device.online'],
        handler: async () => {},
      });

      const event = makeEvent();
      await mod.enqueueRouteEvent(event);

      expect(queueAdd).toHaveBeenCalledTimes(1);
      const [name, data, opts] = queueAdd.mock.calls[0]!;
      expect(name).toBe('route-event');
      expect(opts).toMatchObject({
        jobId: `event-route-${event.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      expect(data).toMatchObject({
        v: 1,
        mode: 'shadow',
        event,
        matchedSubscriberIds: ['automation-worker', 'webhook-delivery'],
        queueSubscriberIds: ['automation-worker', 'webhook-delivery'],
      });
    });

    it('mode enforce + csv: queueSubscriberIds is exactly matched ∩ csv, sorted', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery,dns-threat-alerts');
      registry.registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: ['device.online'],
        handler: async () => {},
      });
      registry.registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: ['device.online'],
        handler: async () => {},
      });

      const event = makeEvent();
      await mod.enqueueRouteEvent(event);

      const [, data] = queueAdd.mock.calls[0]!;
      expect((data as { matchedSubscriberIds: string[] }).matchedSubscriberIds).toEqual([
        'automation-worker',
        'webhook-delivery',
      ]);
      expect((data as { queueSubscriberIds: string[] }).queueSubscriberIds).toEqual(['webhook-delivery']);
    });

    it('a rejected queue.add is caught, logged, captureExceptioned, and NOT rethrown', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      queueAdd.mockRejectedValueOnce(new Error('redis down'));
      const { captureException } = await import('./sentry');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = makeEvent();
      await expect(mod.enqueueRouteEvent(event)).resolves.toBeUndefined();

      const logs = errorSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('enqueue-failed'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.errorId).toBe('EVENT_DISPATCH_ENQUEUE_FAILED');
      expect(payload.eventId).toBe(event.id);
      expect(captureException).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  describe('recordShadowLocalInvocation', () => {
    it('does nothing when mode is not shadow', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'off');
      await mod.recordShadowLocalInvocation(makeEvent(), 'webhook-delivery', 'ok');
      expect(redisMulti).not.toHaveBeenCalled();
      expect(pipelineHincrby).not.toHaveBeenCalled();
      expect(pipelineHset).not.toHaveBeenCalled();
    });

    it('always increments the per-subscriber/outcome counter in shadow mode, via one pipeline', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      // 0xff = 255, well above the <26 sampling threshold, and the type isn't
      // alert.*/policy.* — so this event is NOT sampled, but the counter still
      // fires unconditionally.
      const event = makeEvent({ id: 'ff000000-0000-4000-8000-000000000000', type: 'device.online' as EventType });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok');
      expect(pipelineHincrby).toHaveBeenCalledWith('breeze:event-shadow:count:webhook-delivery', 'ok', 1);
      // One multi() / one exec() — the whole point of coalescing.
      expect(redisMulti).toHaveBeenCalledTimes(1);
      expect(pipelineExec).toHaveBeenCalledTimes(1);
    });

    it('records sampled-detail HSET+EXPIRE for alert.* events (100% sampled), in the SAME pipeline as the counter', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({
        id: 'ff000000-0000-4000-8000-000000000000',
        type: 'alert.triggered' as EventType,
      });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'error');
      expect(pipelineHincrby).toHaveBeenCalledWith('breeze:event-shadow:count:webhook-delivery', 'error', 1);
      expect(pipelineHset).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 'webhook-delivery', 'error');
      expect(pipelineExpire).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 7200);
      expect(redisMulti).toHaveBeenCalledTimes(1);
      expect(pipelineExec).toHaveBeenCalledTimes(1);
    });

    it('records sampled-detail for policy.* events too (100% sampled)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({
        id: 'ff000000-0000-4000-8000-000000000000',
        type: 'policy.evaluated' as EventType,
      });
      await mod.recordShadowLocalInvocation(event, 'automation-worker', 'ok');
      expect(pipelineHset).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 'automation-worker', 'ok');
    });

    it('skips the sampled-detail HSET/EXPIRE for a non-sampled event id/type, but still pipelines the counter', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({ id: 'ff000000-0000-4000-8000-000000000000', type: 'device.online' as EventType });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok');
      expect(pipelineHincrby).toHaveBeenCalledTimes(1);
      expect(pipelineHset).not.toHaveBeenCalled();
      expect(pipelineExpire).not.toHaveBeenCalled();
      expect(pipelineExec).toHaveBeenCalledTimes(1);
    });

    it('never throws synchronously when the pipeline exec rejects (shadow bookkeeping must never break delivery)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      pipelineExec.mockRejectedValueOnce(new Error('redis down'));
      const event = makeEvent({ type: 'alert.triggered' as EventType });
      await expect(mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok')).rejects.toThrow();
      // The rejection is real (so a caller's .catch() sees it), but nothing in
      // THIS module crashes synchronously — the promise simply rejects.
    });

    // #4125: ioredis resolves `exec()` with one [error, result] tuple per queued
    // command. A per-command failure NEVER rejects, so it can't reach the
    // caller's `.catch()` in eventBus.ts — it has to be inspected here.
    it('warns on a per-command error tuple, without rejecting', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pipelineExec.mockResolvedValueOnce([
        [null, 1],
        [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null],
        [null, 1],
      ]);

      // The sentry mock is module-scoped and is NOT reset between tests in this
      // file (an earlier case exercises the enqueue-failure captureException),
      // so clear it here to make the assertion below about THIS call only.
      const { captureException } = await import('./sentry');
      vi.mocked(captureException).mockClear();

      const event = makeEvent({ type: 'alert.triggered' as EventType });
      // Resolves (that IS the bug — the caller's .catch() never fires), so the
      // warning has to come from inside this module.
      await expect(
        mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok'),
      ).resolves.toBeUndefined();

      const logs = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('shadow-record-command-failed'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.errorId).toBe('EVENT_DISPATCH_SHADOW_COMMAND_FAILED');
      expect(payload.eventId).toBe(event.id);
      expect(payload.eventType).toBe('alert.triggered');
      expect(payload.orgId).toBe('org-1');
      expect(payload.subscriberId).toBe('webhook-delivery');
      expect(payload.outcome).toBe('ok');
      // Index 1 of a sampled (3-command) pipeline is the per-event detail HSET,
      // and the line has to SAY so — a bare index means nothing on an on-call
      // pager when the pipeline is 1 command long half the time.
      expect(payload.failures).toEqual([
        {
          index: 1,
          command: 'hset:detail',
          error: expect.objectContaining({
            name: 'Error',
            message: expect.stringContaining('WRONGTYPE'),
            stack: expect.any(String),
          }),
        },
      ]);

      // Deliberately log-only: this runs once per local subscriber invocation at
      // full event volume, so a broken shadow key must not become one Sentry
      // event per invocation. Pinned so a future "helpful" fix has to argue with
      // a failing test rather than an absence.
      expect(captureException).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('names the failing command for a non-sampled, single-command pipeline', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // 0xff is above the <26 sampling threshold and device.online isn't
      // alert.*/policy.*, so only the counter is queued — a ONE-tuple result.
      pipelineExec.mockResolvedValueOnce([[new Error('OOM command not allowed'), null]]);

      await mod.recordShadowLocalInvocation(
        makeEvent({ id: 'ff000000-0000-4000-8000-000000000000', type: 'device.online' as EventType }),
        'webhook-delivery',
        'ok',
      );

      expect(pipelineHset).not.toHaveBeenCalled();
      const logs = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('shadow-record-command-failed'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.failures).toEqual([
        { index: 0, command: 'hincrby:count', error: expect.objectContaining({ name: 'Error' }) },
      ]);

      warnSpy.mockRestore();
    });

    it('reports every failing command in one warning line', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pipelineExec.mockResolvedValueOnce([
        [new Error('WRONGTYPE hincrby'), null],
        [null, 1],
        [new Error('ERR expire'), null],
      ]);

      await mod.recordShadowLocalInvocation(
        makeEvent({ type: 'alert.triggered' as EventType }),
        'automation-worker',
        'error',
      );

      const logs = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('shadow-record-command-failed'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.failures.map((f: { index: number }) => f.index)).toEqual([0, 2]);
      expect(payload.failures.map((f: { command: string }) => f.command)).toEqual([
        'hincrby:count',
        'expire:detail',
      ]);

      warnSpy.mockRestore();
    });

    it('stays quiet when every queued command succeeded', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pipelineExec.mockResolvedValueOnce([
        [null, 1],
        [null, 1],
        [null, 1],
      ]);

      await mod.recordShadowLocalInvocation(
        makeEvent({ type: 'alert.triggered' as EventType }),
        'webhook-delivery',
        'ok',
      );

      expect(
        warnSpy.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('shadow-record'),
        ),
      ).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('warns when exec() resolves null (the MULTI was discarded — nothing ran)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pipelineExec.mockResolvedValueOnce(null);

      const event = makeEvent({ type: 'alert.triggered' as EventType });
      await expect(
        mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok'),
      ).resolves.toBeUndefined();

      const logs = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('shadow-record-discarded'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.errorId).toBe('EVENT_DISPATCH_SHADOW_PIPELINE_DISCARDED');
      expect(payload.eventId).toBe(event.id);
      expect(payload.subscriberId).toBe('webhook-delivery');

      warnSpy.mockRestore();
    });
  });

  describe('isShadowSampledEvent', () => {
    it('always samples alert.* and policy.* events regardless of id', () => {
      expect(
        mod.isShadowSampledEvent(makeEvent({ type: 'alert.triggered' as EventType, id: 'ff000000-0000-4000-8000-000000000000' })),
      ).toBe(true);
      expect(
        mod.isShadowSampledEvent(makeEvent({ type: 'policy.evaluated' as EventType, id: 'ff000000-0000-4000-8000-000000000000' })),
      ).toBe(true);
    });

    it('deterministically samples ~10% of other event types by id hash', () => {
      expect(mod.isShadowSampledEvent(makeEvent({ id: '00000000-0000-4000-8000-000000000000' }))).toBe(true); // 0x00 < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: '19000000-0000-4000-8000-000000000000' }))).toBe(true); // 0x19=25 < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: '1a000000-0000-4000-8000-000000000000' }))).toBe(false); // 0x1a=26, not < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: 'ff000000-0000-4000-8000-000000000000' }))).toBe(false);
    });
  });

  describe('getEventDispatchQueue / shutdownEventDispatchQueue', () => {
    it('returns the same singleton on repeated calls and closes it on shutdown', async () => {
      const q1 = mod.getEventDispatchQueue();
      const q2 = mod.getEventDispatchQueue();
      expect(q1).toBe(q2);

      await mod.shutdownEventDispatchQueue();
      expect(queueClose).toHaveBeenCalledTimes(1);
    });
  });
});

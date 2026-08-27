import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, valuesMock, systemContextMock, outsideContextMock, captureExceptionMock } =
  vi.hoisted(() => {
    const valuesMock = vi.fn(async (_row: Record<string, unknown>) => undefined);
    return {
      valuesMock,
      insertMock: vi.fn(() => ({ values: valuesMock })),
      systemContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      outsideContextMock: vi.fn((fn: () => unknown) => fn()),
      captureExceptionMock: vi.fn(),
    };
  });

vi.mock('../../db', () => ({
  db: { insert: insertMock },
  withSystemDbAccessContext: systemContextMock,
  runOutsideDbContext: outsideContextMock,
}));

vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { llmEgressEvents } from '../../db/schema/llmEgressEvents';
import {
  LLM_EGRESS_QUEUE_LIMIT,
  __resetLlmEgressRecorderForTests,
  drainLlmEgressQueue,
  recordLlmEgressEvent,
} from './llmEgressRecorder';

const BASE = {
  orgId: '11111111-1111-1111-1111-111111111111',
  partnerId: '22222222-2222-2222-2222-222222222222',
  surface: 'one_shot_probe' as const,
  host: 'openrouter.ai',
  resolvedIp: '93.184.216.34',
  blocked: false,
};

describe('recordLlmEgressEvent', () => {
  beforeEach(() => {
    __resetLlmEgressRecorderForTests();
    insertMock.mockClear();
    valuesMock.mockClear();
    valuesMock.mockResolvedValue(undefined);
    systemContextMock.mockClear();
    captureExceptionMock.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns synchronously — the LLM call path never awaits the audit write', () => {
    expect(recordLlmEgressEvent(BASE)).toBeUndefined();
  });

  it('inserts the attempt under a system DB context', async () => {
    recordLlmEgressEvent(BASE);
    await drainLlmEgressQueue();

    expect(systemContextMock).toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledWith(llmEgressEvents);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: BASE.orgId,
        partnerId: BASE.partnerId,
        surface: 'one_shot_probe',
        host: 'openrouter.ai',
        resolvedIp: '93.184.216.34',
        blocked: false,
      }),
    );
  });

  it('escapes a held request DB context before opening the system one', async () => {
    recordLlmEgressEvent(BASE);
    await drainLlmEgressQueue();

    expect(outsideContextMock).toHaveBeenCalled();
  });

  it('records a blocked attempt with a null resolved IP', async () => {
    recordLlmEgressEvent({ ...BASE, resolvedIp: null, blocked: true });
    await drainLlmEgressQueue();

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedIp: null, blocked: true }),
    );
  });

  it('swallows an insert failure — auditing never fails the traffic it observes', async () => {
    valuesMock.mockRejectedValueOnce(new Error('db is down'));

    recordLlmEgressEvent(BASE);
    await expect(drainLlmEgressQueue()).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('keeps draining after a failed insert', async () => {
    valuesMock.mockRejectedValueOnce(new Error('db is down'));

    recordLlmEgressEvent(BASE);
    recordLlmEgressEvent({ ...BASE, host: 'second.example.com' });
    await drainLlmEgressQueue();

    expect(valuesMock).toHaveBeenCalledTimes(2);
  });

  it('drops the OLDEST pending event above the queue limit rather than back-pressuring', async () => {
    // Hold the drain open so the queue can actually build up.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    valuesMock.mockImplementationOnce(async () => {
      await gate;
    });

    const total = LLM_EGRESS_QUEUE_LIMIT + 5;
    for (let i = 0; i < total; i += 1) recordLlmEgressEvent({ ...BASE, host: `h${i}.example.com` });

    release();
    await drainLlmEgressQueue();

    // The first event is in flight; of the rest, only the newest LIMIT survive.
    const written = valuesMock.mock.calls.map((call) => String(call[0]?.host));
    expect(written).toHaveLength(LLM_EGRESS_QUEUE_LIMIT + 1);
    expect(written[0]).toBe('h0.example.com');
    expect(written).not.toContain('h1.example.com');
    expect(written[written.length - 1]).toBe(`h${total - 1}.example.com`);
  });

  it('warns exactly once about drops, however many events are shed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    valuesMock.mockImplementationOnce(async () => {
      await gate;
    });

    for (let i = 0; i < LLM_EGRESS_QUEUE_LIMIT + 20; i += 1) {
      recordLlmEgressEvent({ ...BASE, host: `h${i}.example.com` });
    }
    release();
    await drainLlmEgressQueue();

    const dropWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('llmEgressRecorder'),
    );
    expect(dropWarnings).toHaveLength(1);
  });
});

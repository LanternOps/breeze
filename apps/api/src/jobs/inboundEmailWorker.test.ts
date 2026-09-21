import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  processInboundEmailMock,
  resolveChecksMock,
  peekMock,
  chargeMock,
  getRedisMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
} = vi.hoisted(() => {
  const withSystemDbAccessContextMock = vi.fn(<T>(fn: () => Promise<T>) => fn());
  const runOutsideDbContextMock = vi.fn(<T>(fn: () => T) => fn());
  return {
    processInboundEmailMock: vi.fn().mockResolvedValue(undefined),
    resolveChecksMock: vi.fn().mockResolvedValue([]),
    peekMock: vi.fn().mockResolvedValue({ throttled: false, bucket: null }),
    chargeMock: vi.fn().mockResolvedValue(undefined),
    getRedisMock: vi.fn(() => ({})),
    withSystemDbAccessContextMock,
    runOutsideDbContextMock
  };
});

vi.mock('bullmq', () => {
  class MockWorker {
    on() { return this; }
    async close() { return undefined; }
  }
  return {
    Queue: vi.fn(() => ({ add: vi.fn() })),
    Worker: MockWorker
  };
});
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})), getRedis: getRedisMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock
}));
vi.mock('../services/inboundEmail/inboundEmailService', () => ({
  processInboundEmail: processInboundEmailMock,
  resolveInboundThrottleChecks: resolveChecksMock
}));
vi.mock('../services/inboundEmail/inboundRateLimit', () => ({
  peekInboundThrottle: peekMock,
  chargeInboundTickets: chargeMock
}));
vi.mock('../services/inboundEmailQueue', () => ({
  INBOUND_EMAIL_QUEUE: 'inbound-email'
}));

import * as workerModule from './inboundEmailWorker';

const makeEmail = (overrides: Partial<{ providerMessageId: string }> = {}) => ({
  provider: 'mailgun' as const,
  providerMessageId: 'mg-abc-123',
  to: 'support@acme.tickets.example.com',
  from: 'user@customer.example.com',
  fromName: 'A User',
  subject: 'Printer broken',
  text: 'Help',
  attachments: [],
  raw: {},
  ...overrides
});

describe('inboundEmailWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSystemDbAccessContextMock.mockImplementation(<T>(fn: () => Promise<T>) => fn());
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    processInboundEmailMock.mockResolvedValue(undefined);
    resolveChecksMock.mockResolvedValue([]);
    peekMock.mockResolvedValue({ throttled: false, bucket: null });
    chargeMock.mockResolvedValue(undefined);
    getRedisMock.mockReturnValue({});
  });

  // TEST 1: drive the REAL exported handleInboundEmail and verify the
  // runOutsideDbContext → withSystemDbAccessContext → processInboundEmail ordering
  // (the #1105 pool-poison guard). Both the throttle-resolve context and the
  // pipeline context follow that ordering.
  it('real handleInboundEmail: each DB context is opened via runOutsideDbContext, and the pipeline runs inside one', async () => {
    const callOrder: string[] = [];

    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T): T => {
      callOrder.push('runOutsideDbContext');
      return fn();
    });
    withSystemDbAccessContextMock.mockImplementation(<T>(fn: () => Promise<T>): Promise<T> => {
      callOrder.push('withSystemDbAccessContext');
      return fn();
    });
    processInboundEmailMock.mockImplementation(async () => {
      callOrder.push('processInboundEmail');
    });

    const email = makeEmail();
    await workerModule.handleInboundEmail({ data: { email } } as any);

    // Two DB contexts: (1) resolve the flood windows, (2) run the pipeline. Each is
    // wrapped in runOutsideDbContext → withSystemDbAccessContext.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(2);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    // processInboundEmail receives (email, gen, deps, throttleVerdict).
    expect(processInboundEmailMock).toHaveBeenCalledWith(
      email,
      undefined,
      expect.objectContaining({ onTicketCreated: expect.any(Function) }),
      { throttled: false, bucket: null },
    );
    // Every runOutsideDbContext precedes its withSystemDbAccessContext, which
    // precedes the pipeline work.
    expect(callOrder.indexOf('runOutsideDbContext')).toBeLessThan(callOrder.indexOf('withSystemDbAccessContext'));
    expect(callOrder.indexOf('withSystemDbAccessContext')).toBeLessThan(callOrder.indexOf('processInboundEmail'));
  });

  it('PEEKS the resolved windows before running the pipeline (Redis outside the held tx)', async () => {
    const checks = [{ bucket: 'sender' as const, key: 'inbound:tix:sender:p1:jane@acme.com', limit: 30 }];
    resolveChecksMock.mockResolvedValue(checks);
    const order: string[] = [];
    peekMock.mockImplementation(async () => { order.push('peek'); return { throttled: false, bucket: null }; });
    processInboundEmailMock.mockImplementation(async () => { order.push('process'); });

    await workerModule.handleInboundEmail({ data: { email: makeEmail() } } as any);

    // Peek is called with the real Redis client and the resolved checks, before the pipeline.
    expect(peekMock).toHaveBeenCalledWith({}, checks);
    expect(order).toEqual(['peek', 'process']);
  });

  it('CHARGES the windows after commit ONLY when a ticket was created', async () => {
    const checks = [{ bucket: 'sender' as const, key: 'inbound:tix:sender:p1:jane@acme.com', limit: 30 }];
    resolveChecksMock.mockResolvedValue(checks);
    // The pipeline signals a creation via the onTicketCreated callback.
    processInboundEmailMock.mockImplementation(async (_e: unknown, _g: unknown, deps: any) => {
      deps?.onTicketCreated?.();
    });

    const email = makeEmail({ providerMessageId: 'mg-created-1' });
    await workerModule.handleInboundEmail({ data: { email } } as any);

    expect(chargeMock).toHaveBeenCalledWith({}, checks, 'mg-created-1');
  });

  it('does NOT charge when no ticket was created (peek/pipeline made none)', async () => {
    resolveChecksMock.mockResolvedValue([{ bucket: 'sender' as const, key: 'k', limit: 30 }]);
    processInboundEmailMock.mockResolvedValue(undefined); // never calls onTicketCreated

    await workerModule.handleInboundEmail({ data: { email: makeEmail() } } as any);

    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('does NOT charge when there are no cap windows, even if a ticket was created', async () => {
    resolveChecksMock.mockResolvedValue([]); // caps unlimited / partner unresolved
    processInboundEmailMock.mockImplementation(async (_e: unknown, _g: unknown, deps: any) => {
      deps?.onTicketCreated?.();
    });

    await workerModule.handleInboundEmail({ data: { email: makeEmail() } } as any);

    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('passes an exact M365 mailbox generation to both the throttle resolve and the pipeline', async () => {
    const email = makeEmail({ providerMessageId: 'graph-1' });
    const mailboxGeneration = {
      connectionId: '44444444-4444-4444-8444-444444444444',
      partnerId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '66666666-6666-4666-8666-666666666666',
    };

    await workerModule.handleInboundEmail({ data: { email, mailboxGeneration } } as any);

    expect(resolveChecksMock).toHaveBeenCalledWith(email, mailboxGeneration);
    expect(processInboundEmailMock).toHaveBeenCalledWith(
      email,
      mailboxGeneration,
      expect.objectContaining({ onTicketCreated: expect.any(Function) }),
      { throttled: false, bucket: null },
    );
  });

  it('continues to consume legacy raw-email jobs queued before the contract rollout', async () => {
    const email = makeEmail({ providerMessageId: 'legacy-raw' });

    await workerModule.handleInboundEmail({ data: email } as any);

    expect(processInboundEmailMock).toHaveBeenCalledWith(
      email,
      undefined,
      expect.objectContaining({ onTicketCreated: expect.any(Function) }),
      { throttled: false, bucket: null },
    );
  });
});

// Test that initializeInboundEmailWorker and shutdownInboundEmailWorker are exported
describe('inboundEmailWorker exports', () => {
  it('exports initializeInboundEmailWorker', () => {
    expect(typeof workerModule.initializeInboundEmailWorker).toBe('function');
  });

  it('exports shutdownInboundEmailWorker', () => {
    expect(typeof workerModule.shutdownInboundEmailWorker).toBe('function');
  });

  it('exports handleInboundEmail', () => {
    expect(typeof workerModule.handleInboundEmail).toBe('function');
  });

  it('initializeInboundEmailWorker resolves without throwing', async () => {
    await expect(workerModule.initializeInboundEmailWorker()).resolves.toBeUndefined();
  });

  it('shutdownInboundEmailWorker resolves without throwing', async () => {
    // Initialize first (creates the worker), then shut down
    await workerModule.initializeInboundEmailWorker();
    await expect(workerModule.shutdownInboundEmailWorker()).resolves.toBeUndefined();
  });
});

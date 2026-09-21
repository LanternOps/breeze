import { describe, it, expect, vi, beforeEach } from 'vitest';

const { processInboundEmailMock, runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const withSystemDbAccessContextMock = vi.fn(<T>(fn: () => Promise<T>) => fn());
  const runOutsideDbContextMock = vi.fn(<T>(fn: () => T) => fn());
  return {
    processInboundEmailMock: vi.fn().mockResolvedValue(undefined),
    withSystemDbAccessContextMock,
    runOutsideDbContextMock
  };
});

vi.mock('bullmq', () => {
  const workerCtorArgs: unknown[][] = [];
  class MockWorker {
    constructor(...args: unknown[]) { workerCtorArgs.push(args); }
    on() { return this; }
    async close() { return undefined; }
  }
  return {
    Queue: vi.fn(() => ({ add: vi.fn() })),
    Worker: MockWorker,
    // Test-only: every Worker construction's positional args, so a test can assert
    // the flood-backpressure limiter is actually installed (finding: a mock that
    // discards ctor args lets the limiter be removed with the test still green).
    __workerCtorArgs: workerCtorArgs,
  };
});
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock
}));
vi.mock('../services/inboundEmail/inboundEmailService', () => ({
  processInboundEmail: processInboundEmailMock
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
  });

  // Drive the REAL exported handleInboundEmail and verify the
  // runOutsideDbContext → withSystemDbAccessContext → processInboundEmail ordering
  // (the #1105 pool-poison guard).
  it('real handleInboundEmail: runOutsideDbContext before withSystemDbAccessContext before processInboundEmail', async () => {
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

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(processInboundEmailMock).toHaveBeenCalledWith(email, undefined);
    expect(callOrder.indexOf('runOutsideDbContext')).toBeLessThan(callOrder.indexOf('withSystemDbAccessContext'));
    expect(callOrder.indexOf('withSystemDbAccessContext')).toBeLessThan(callOrder.indexOf('processInboundEmail'));
  });

  it('real handleInboundEmail: resolves without throwing when processInboundEmail succeeds', async () => {
    const email = makeEmail({ providerMessageId: 'mg-xyz-999' });
    await expect(workerModule.handleInboundEmail({ data: { email } } as any)).resolves.toBeUndefined();
    expect(processInboundEmailMock).toHaveBeenCalledWith(email, undefined);
  });

  it('passes an exact M365 mailbox generation to the transactional ingestion service', async () => {
    const email = makeEmail({ providerMessageId: 'graph-1' });
    const mailboxGeneration = {
      connectionId: '44444444-4444-4444-8444-444444444444',
      partnerId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '66666666-6666-4666-8666-666666666666',
    };

    await workerModule.handleInboundEmail({ data: { email, mailboxGeneration } } as any);

    expect(processInboundEmailMock).toHaveBeenCalledWith(email, mailboxGeneration);
  });

  it('continues to consume legacy raw-email jobs queued before the contract rollout', async () => {
    const email = makeEmail({ providerMessageId: 'legacy-raw' });

    await workerModule.handleInboundEmail({ data: email } as any);

    expect(processInboundEmailMock).toHaveBeenCalledWith(email, undefined);
  });
});

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

  it('installs the flood-backpressure rate limiter on the Worker', async () => {
    const bullmq = (await import('bullmq')) as unknown as { __workerCtorArgs: unknown[][] };
    const { inboundQueueMaxPerSec } = await import('../config/env');
    // Force a fresh Worker construction (the module holds a singleton) and capture
    // the options it is built with.
    await workerModule.shutdownInboundEmailWorker();
    bullmq.__workerCtorArgs.length = 0;
    await workerModule.initializeInboundEmailWorker();

    const args = bullmq.__workerCtorArgs.at(-1);
    expect(args, 'a Worker was constructed').toBeTruthy();
    const opts = args![2] as { limiter?: { max: number; duration: number }; concurrency?: number };
    expect(opts.limiter).toEqual({ max: inboundQueueMaxPerSec(), duration: 1000 });
    await workerModule.shutdownInboundEmailWorker();
  });

  it('shutdownInboundEmailWorker resolves without throwing', async () => {
    await workerModule.initializeInboundEmailWorker();
    await expect(workerModule.shutdownInboundEmailWorker()).resolves.toBeUndefined();
  });
});

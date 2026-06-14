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
  class MockWorker {
    on() { return this; }
    async close() { return undefined; }
  }
  return {
    Queue: vi.fn(() => ({ add: vi.fn() })),
    Worker: MockWorker
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

  // TEST 1: drive the REAL exported handleInboundEmail and verify the
  // runOutsideDbContext → withSystemDbAccessContext → processInboundEmail ordering
  // (the #1105 pool-poison guard).
  it('real handleInboundEmail: calls runOutsideDbContext before withSystemDbAccessContext before processInboundEmail', async () => {
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
    // Call the REAL exported handler (not the mocks directly)
    await workerModule.handleInboundEmail({ data: email } as any);

    // (a) runOutsideDbContext was called
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    // (b) withSystemDbAccessContext was called INSIDE runOutsideDbContext
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    // (c) processInboundEmail received job.data
    expect(processInboundEmailMock).toHaveBeenCalledWith(email);
    // Ordering assertion: runOutsideDbContext must come before withSystemDbAccessContext
    expect(callOrder.indexOf('runOutsideDbContext')).toBeLessThan(callOrder.indexOf('withSystemDbAccessContext'));
    expect(callOrder.indexOf('withSystemDbAccessContext')).toBeLessThan(callOrder.indexOf('processInboundEmail'));
  });

  it('real handleInboundEmail: resolves without throwing when processInboundEmail succeeds', async () => {
    const email = makeEmail({ providerMessageId: 'mg-xyz-999' });
    await expect(workerModule.handleInboundEmail({ data: email } as any)).resolves.toBeUndefined();
    expect(processInboundEmailMock).toHaveBeenCalledWith(email);
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

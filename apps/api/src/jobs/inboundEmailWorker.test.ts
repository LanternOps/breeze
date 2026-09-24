import { describe, it, expect, vi, beforeEach } from 'vitest';

const { processInboundEmailMock, runOutsideDbContextMock, withSystemDbAccessContextMock, InboundEmailProcessingRecordedMock } = vi.hoisted(() => {
  const withSystemDbAccessContextMock = vi.fn(<T>(fn: () => Promise<T>) => fn());
  const runOutsideDbContextMock = vi.fn(<T>(fn: () => T) => fn());
  // Stand-in for the real sentinel: the worker checks `instanceof` against the
  // class it imports from the (mocked) service, so the mock must export THIS class
  // and the tests must throw instances of it for the identity check to hold.
  class InboundEmailProcessingRecorded extends Error {}
  return {
    processInboundEmailMock: vi.fn().mockResolvedValue(undefined),
    withSystemDbAccessContextMock,
    runOutsideDbContextMock,
    InboundEmailProcessingRecordedMock: InboundEmailProcessingRecorded,
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
  processInboundEmail: processInboundEmailMock,
  InboundEmailProcessingRecorded: InboundEmailProcessingRecordedMock
}));
vi.mock('../services/inboundEmailQueue', () => ({
  INBOUND_EMAIL_QUEUE: 'inbound-email'
}));
const { prepareMock, discardMock } = vi.hoisted(() => ({
  prepareMock: vi.fn().mockResolvedValue(undefined),
  discardMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/ticketMailbox/fetchInboundAttachments', () => ({
  prepareM365Attachments: prepareMock,
  discardUnpersistedAttachments: discardMock,
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

  it('SWALLOWS the recorded-failure sentinel (no BullMQ retry — the durable failed row is terminal)', async () => {
    processInboundEmailMock.mockRejectedValue(new InboundEmailProcessingRecordedMock('recorded'));
    const email = makeEmail({ providerMessageId: 'mg-fail-1' });
    // Resolves (does not reject) so BullMQ marks the job done rather than retrying;
    // processInboundEmail already recorded the durable failed row and rolled back.
    await expect(workerModule.handleInboundEmail({ data: { email } } as any)).resolves.toBeUndefined();
  });

  it('RETHROWS a genuine infra error so BullMQ retries the job', async () => {
    const infra = new Error('redis connection reset');
    processInboundEmailMock.mockRejectedValue(infra);
    const email = makeEmail({ providerMessageId: 'mg-fail-2' });
    await expect(workerModule.handleInboundEmail({ data: { email } } as any)).rejects.toBe(infra);
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

  describe('M365 attachments (#6688)', () => {
    const mailboxGeneration = {
      connectionId: '44444444-4444-4444-8444-444444444444',
      partnerId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '66666666-6666-4666-8666-666666666666',
    };
    const m365 = (hasAttachments: boolean) => ({ ...makeEmail(), provider: 'm365' as const, hasAttachments });

    it('fetches attachments BEFORE opening the DB transaction, then discards unpersisted blobs', async () => {
      const callOrder: string[] = [];
      prepareMock.mockImplementationOnce(async () => { callOrder.push('prepare'); });
      withSystemDbAccessContextMock.mockImplementation(<T>(fn: () => Promise<T>) => {
        callOrder.push('withSystemDbAccessContext');
        return fn();
      });
      discardMock.mockImplementationOnce(async () => { callOrder.push('discard'); });
      const email = m365(true);

      await workerModule.handleInboundEmail({
        data: { email, mailboxGeneration }, attemptsMade: 0, opts: { attempts: 3 },
      } as any);

      expect(prepareMock).toHaveBeenCalledWith(email, { tenantId: mailboxGeneration.tenantId, finalAttempt: false });
      expect(callOrder).toEqual(['prepare', 'withSystemDbAccessContext', 'discard']);
    });

    it('flags the final BullMQ attempt so a Graph failure degrades instead of dropping the email', async () => {
      const email = m365(true);
      await workerModule.handleInboundEmail({
        data: { email, mailboxGeneration }, attemptsMade: 2, opts: { attempts: 3 },
      } as any);
      expect(prepareMock).toHaveBeenCalledWith(email, { tenantId: mailboxGeneration.tenantId, finalAttempt: true });
    });

    it('still discards unpersisted blobs when processing throws', async () => {
      processInboundEmailMock.mockRejectedValueOnce(new Error('boom'));
      const email = m365(true);
      await expect(workerModule.handleInboundEmail({ data: { email, mailboxGeneration } } as any)).rejects.toThrow('boom');
      expect(discardMock).toHaveBeenCalledWith(email);
    });

    it('a failed attachment prep propagates (BullMQ retries) and never creates the ticket without its files', async () => {
      prepareMock.mockRejectedValueOnce(new Error('Graph 503'));
      await expect(workerModule.handleInboundEmail({
        data: { email: m365(true), mailboxGeneration }, attemptsMade: 0, opts: { attempts: 3 },
      } as any)).rejects.toThrow('Graph 503');
      expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
      expect(processInboundEmailMock).not.toHaveBeenCalled();
    });

    it('makes no attachment call when hasAttachments is false', async () => {
      await workerModule.handleInboundEmail({ data: { email: m365(false), mailboxGeneration } } as any);
      expect(prepareMock).not.toHaveBeenCalled();
      expect(discardMock).not.toHaveBeenCalled();
    });

    it('makes no attachment call for a job without a mailbox generation (Mailgun / legacy)', async () => {
      await workerModule.handleInboundEmail({ data: { email: makeEmail() } } as any);
      expect(prepareMock).not.toHaveBeenCalled();
    });
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

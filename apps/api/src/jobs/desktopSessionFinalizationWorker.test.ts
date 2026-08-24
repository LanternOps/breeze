import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queueAddMock,
  queueGetJobMock,
  finalizeDesktopSessionOnceMock,
  getDesktopFinalizationIntentMock,
  releaseDesktopFinalizationIntentMock,
} = vi.hoisted(() => ({
  queueAddMock: vi.fn(),
  queueGetJobMock: vi.fn(),
  finalizeDesktopSessionOnceMock: vi.fn(),
  getDesktopFinalizationIntentMock: vi.fn(),
  releaseDesktopFinalizationIntentMock: vi.fn(),
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: queueAddMock,
    getJob: queueGetJobMock,
    close: vi.fn(),
  })),
}));

vi.mock('../services/desktopSessionFinalization', () => ({
  finalizeDesktopSessionOnce: finalizeDesktopSessionOnceMock,
  getDesktopFinalizationIntent: getDesktopFinalizationIntentMock,
  releaseDesktopFinalizationIntent: releaseDesktopFinalizationIntentMock,
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

import {
  classifyDesktopFinalizationFailure,
  DesktopFinalizationIntentAbsentError,
  DesktopFinalizationIntentMismatchError,
  DesktopFinalizationIntentReleaseError,
  DesktopFinalizationStopPendingError,
  enqueueDesktopSessionFinalization,
  processDesktopSessionFinalizationJob,
} from './desktopSessionFinalizationWorker';
import { WORKER_FAILURE_REASONS } from './workerObservability';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZATION_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = `desktop-finalize-${SESSION_ID}-${FINALIZATION_ID}`;

describe('desktop session finalization worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: JOB_ID });
    getDesktopFinalizationIntentMock.mockResolvedValue({
      input: {
        version: 1,
        sessionId: SESSION_ID,
        finalizationId: FINALIZATION_ID,
      },
      canonicalPayload: '{"exact":true}',
      payloadSha256: 'a'.repeat(64),
    });
    finalizeDesktopSessionOnceMock.mockResolvedValue('finalized');
    releaseDesktopFinalizationIntentMock.mockResolvedValue(true);
  });

  it('acknowledges only the exact stable job identity with bounded retries', async () => {
    await expect(enqueueDesktopSessionFinalization({
      sessionId: SESSION_ID,
      finalizationId: FINALIZATION_ID,
    })).resolves.toEqual({ acknowledged: true, jobId: JOB_ID });
    expect(queueAddMock).toHaveBeenCalledWith(
      'finalize-desktop-session',
      { version: 1, sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
      expect.objectContaining({
        jobId: JOB_ID,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
      }),
    );

    queueAddMock.mockResolvedValueOnce({ id: 'different' });
    await expect(enqueueDesktopSessionFinalization({
      sessionId: SESSION_ID,
      finalizationId: FINALIZATION_ID,
    })).rejects.toThrow('acknowledgement mismatch');
  });

  it('retains the exact intent while stop acknowledgement is pending', async () => {
    finalizeDesktopSessionOnceMock.mockResolvedValue('stop_pending');
    await expect(processDesktopSessionFinalizationJob({
      name: 'finalize-desktop-session',
      data: { version: 1, sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
    } as any)).rejects.toThrow(DesktopFinalizationStopPendingError);
    expect(releaseDesktopFinalizationIntentMock).not.toHaveBeenCalled();
  });

  it('compare-deletes only after exact persisted finalization succeeds', async () => {
    await expect(processDesktopSessionFinalizationJob({
      name: 'finalize-desktop-session',
      data: { version: 1, sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
    } as any)).resolves.toEqual({ result: 'finalized' });
    expect(releaseDesktopFinalizationIntentMock).toHaveBeenCalledWith(
      SESSION_ID,
      FINALIZATION_ID,
      '{"exact":true}',
    );

    releaseDesktopFinalizationIntentMock.mockResolvedValueOnce(false);
    await expect(processDesktopSessionFinalizationJob({
      name: 'finalize-desktop-session',
      data: { version: 1, sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
    } as any)).rejects.toThrow(DesktopFinalizationIntentReleaseError);
  });
});

// BREEZE-1J. In production `scrubEvent` deletes the message from every event,
// so four different conditions all arrived as `Error: [redacted]` with a single
// app frame. The exception TYPE survives the scrubber, so each condition needs
// its own class — and the expected, self-healing ones must not be error-level.
describe('desktop finalization failure shapes (BREEZE-1J)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finalizeDesktopSessionOnceMock.mockResolvedValue('finalized');
    releaseDesktopFinalizationIntentMock.mockResolvedValue(true);
  });

  const job = {
    name: 'finalize-desktop-session',
    data: { version: 1, sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
  } as any;

  it('discards the job on an already-released intent instead of retrying a lost race', async () => {
    // The only writer that removes the intent is a successful compare-delete, so
    // an absent intent means another finalizer already finished this session.
    // Retrying four more times cannot bring it back — BullMQ's shouldRetryJob
    // honours `discarded` exactly like UnrecoverableError, without this module
    // needing a bullmq VALUE import that would break ~92 partial `vi.mock`s.
    getDesktopFinalizationIntentMock.mockResolvedValue(null);
    const discard = vi.fn();

    const error = await processDesktopSessionFinalizationJob({ ...job, discard } as any)
      .catch((e) => e);

    expect(error).toBeInstanceOf(DesktopFinalizationIntentAbsentError);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(finalizeDesktopSessionOnceMock).not.toHaveBeenCalled();
  });

  it('still throws when the job has no discard method (direct invocation)', async () => {
    getDesktopFinalizationIntentMock.mockResolvedValue(null);

    await expect(processDesktopSessionFinalizationJob(job))
      .rejects.toBeInstanceOf(DesktopFinalizationIntentAbsentError);
  });

  it('keeps a mismatched intent identity as a full-severity, retryable anomaly', async () => {
    getDesktopFinalizationIntentMock.mockResolvedValue({
      input: {
        version: 1,
        sessionId: SESSION_ID,
        finalizationId: '33333333-3333-4333-8333-333333333333',
      },
      canonicalPayload: '{"exact":true}',
      payloadSha256: 'a'.repeat(64),
    });

    const discard = vi.fn();
    const error = await processDesktopSessionFinalizationJob({ ...job, discard } as any)
      .catch((e) => e);

    expect(error).toBeInstanceOf(DesktopFinalizationIntentMismatchError);
    // A genuine identity anomaly keeps its retries — only the lost race is discarded.
    expect(discard).not.toHaveBeenCalled();
    // Not classified → keeps the default error-level report on every attempt.
    expect(classifyDesktopFinalizationFailure(undefined, error)).toBeNull();
  });

  it('classifies a pending agent stop as a warning reported only once the job gives up', () => {
    expect(
      classifyDesktopFinalizationFailure(undefined, new DesktopFinalizationStopPendingError('x')),
    ).toEqual({
      reason: 'desktop_stop_pending',
      level: 'warning',
      reportOnlyWhenExhausted: true,
    });
  });

  it('classifies an already-released intent as a warning, reported on its single attempt', () => {
    expect(
      classifyDesktopFinalizationFailure(undefined, new DesktopFinalizationIntentAbsentError('x')),
    ).toEqual({ reason: 'desktop_intent_already_released', level: 'warning' });
  });

  it('leaves a release failure at full severity', () => {
    expect(
      classifyDesktopFinalizationFailure(undefined, new DesktopFinalizationIntentReleaseError('x')),
    ).toBeNull();
  });

  // `worker_failure_reason` is allowlisted through Sentry's scrubber on the
  // promise that it is a closed set of hardcoded labels — `isBoundedTagValue`
  // only bounds LENGTH, so it would pass a session UUID happily. The
  // WorkerFailureReason union is what enforces that at compile time (an
  // interpolated `desktop_stop_pending_${job.id}` no longer compiles); this
  // pins the runtime side so a cast could not smuggle one past either.
  it('only ever emits reasons that are in the shared registry', () => {
    for (const error of [
      new DesktopFinalizationStopPendingError('x'),
      new DesktopFinalizationIntentAbsentError('x'),
      new DesktopFinalizationIntentMismatchError('x'),
      new DesktopFinalizationIntentReleaseError('x'),
      new Error('anything else'),
    ]) {
      const reason = classifyDesktopFinalizationFailure(undefined, error)?.reason;
      if (reason === undefined) continue;
      expect(WORKER_FAILURE_REASONS).toContain(reason);
    }
  });
});

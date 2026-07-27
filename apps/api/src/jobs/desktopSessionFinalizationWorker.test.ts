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
  enqueueDesktopSessionFinalization,
  processDesktopSessionFinalizationJob,
} from './desktopSessionFinalizationWorker';

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
    } as any)).rejects.toThrow('stop pending');
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
    } as any)).rejects.toThrow('compare-delete failed');
  });
});

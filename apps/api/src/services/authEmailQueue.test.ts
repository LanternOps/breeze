import { describe, it, expect, vi } from 'vitest';

const added: unknown[] = [];
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: () => ({
    add: (name: string, data: unknown, opts?: unknown) => { added.push({ name, data, opts }); return Promise.resolve(); },
  }),
}));

import { enqueuePasswordResetRequest, AUTH_EMAIL_QUEUE } from './authEmailQueue';

describe('authEmailQueue', () => {
  it('enqueues an opaque password-reset job carrying only the submitted address', async () => {
    await enqueuePasswordResetRequest('victim@corp.com');
    expect(AUTH_EMAIL_QUEUE).toBe('auth-email');
    expect(added[0]).toMatchObject({
      name: 'password-reset',
      data: { kind: 'password-reset', email: 'victim@corp.com' },
    });
  });

  it('does NOT retain the completed password-reset job (raw email is PII) and bounds the failed-job tail', async () => {
    // The queue's default retention (removeOnComplete: {count:200}) is sized
    // for the registration job, which carries only a token hash. The
    // password-reset job carries the raw email, so it must override that
    // default rather than let raw addresses accumulate in Redis's completed
    // job history.
    await enqueuePasswordResetRequest('victim@corp.com');
    expect(added[0]).toMatchObject({
      opts: {
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    });
  });
});

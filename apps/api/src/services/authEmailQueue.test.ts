import { describe, it, expect, vi } from 'vitest';

const added: unknown[] = [];
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: () => ({
    add: (name: string, data: unknown) => { added.push({ name, data }); return Promise.resolve(); },
  }),
}));

import { enqueuePasswordResetRequest, AUTH_EMAIL_QUEUE } from './authEmailQueue';

describe('authEmailQueue', () => {
  it('enqueues an opaque password-reset job carrying only the submitted address', async () => {
    await enqueuePasswordResetRequest('victim@corp.com');
    expect(AUTH_EMAIL_QUEUE).toBe('auth-email');
    expect(added).toEqual([
      { name: 'password-reset', data: { kind: 'password-reset', email: 'victim@corp.com' } },
    ]);
  });
});

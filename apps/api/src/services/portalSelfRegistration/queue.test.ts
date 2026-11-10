import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: class { add = addMock; close = vi.fn(); } }));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));

import { enqueuePortalSelfRegistration } from './queue';
import { PORTAL_SELF_REGISTRATION_QUEUE } from './types';

const data = { email: 'pat@contoso.example.com', name: 'Pat Doe', host: 'portal.contoso.example.com' };

beforeEach(() => addMock.mockReset());

describe('enqueuePortalSelfRegistration (W6 D3)', () => {
  it('adds one job with BullMQ-assigned id, one attempt and PII-safe retention', async () => {
    addMock.mockResolvedValue({ id: '1' });
    expect(await enqueuePortalSelfRegistration(data)).toBe(true);
    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('self-register');
    expect(payload).toEqual(data);
    expect(opts).toEqual({ attempts: 1, removeOnComplete: true, removeOnFail: { age: 86_400 } });
    expect(opts).not.toHaveProperty('jobId');
    expect(PORTAL_SELF_REGISTRATION_QUEUE).toBe('portal-self-registration');
  });

  it('returns false and logs no PII when Redis is down', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('redis down');
    failure.message = `connect refused while adding ${data.email}`;
    addMock.mockRejectedValueOnce(failure);
    expect(await enqueuePortalSelfRegistration(data)).toBe(false);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(data.email);
    expect(logged).not.toContain(data.name);
  });
});

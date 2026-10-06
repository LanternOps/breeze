import { describe, it, expect, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn(async (..._a: unknown[]) => ({})) }));
vi.mock('bullmq', () => ({ Queue: vi.fn(function Queue() { return { add: addMock }; }) }));
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { enqueueGmailMarkHandled, gmailMarkHandledJobId, GMAIL_MARK_HANDLED_QUEUE } from './gmailMarkHandledQueue';

const gen = { provider: 'gmail' as const, connectionId: 'c-1', partnerId: 'p-1', tenantId: null, consentAttemptId: 'a-1' };

describe('gmailMarkHandledQueue', () => {
  it('derives one stable, BullMQ-safe job id per message and generation', () => {
    const id = gmailMarkHandledJobId('gmail:sub:m1', gen);
    expect(id).toBe(gmailMarkHandledJobId('gmail:sub:m1', gen));
    expect(id).not.toContain(':');
    expect(id).not.toBe(gmailMarkHandledJobId('gmail:sub:m2', gen));
    expect(id).not.toBe(gmailMarkHandledJobId('gmail:sub:m1', { ...gen, consentAttemptId: 'a-2' }));
    expect(id).not.toBe(gmailMarkHandledJobId('gmail:sub:m1', { ...gen, connectionId: 'c-2' }));
  });

  it('enqueues only the message id and generation, under that job id', async () => {
    expect(GMAIL_MARK_HANDLED_QUEUE).toBe('gmail-mark-handled');
    await enqueueGmailMarkHandled('gmail:sub:m1', gen);
    expect(addMock).toHaveBeenCalledWith(
      'mark',
      { email: { provider: 'gmail', providerMessageId: 'gmail:sub:m1' }, generation: gen },
      expect.objectContaining({ jobId: gmailMarkHandledJobId('gmail:sub:m1', gen), attempts: 3 }),
    );
  });
});

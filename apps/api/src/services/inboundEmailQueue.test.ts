import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn(async () => undefined) }));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = addMock;
  },
}));
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { enqueueInboundEmail } from './inboundEmailQueue';

const email = {
  provider: 'm365' as const,
  providerMessageId: 'graph-1',
  to: 'support@example.com',
  from: 'customer@example.net',
  subject: 'Help',
  text: 'Printer is down',
  attachments: [],
  raw: {},
};

describe('enqueueInboundEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores the explicit mailbox generation alongside the normalized email', async () => {
    const mailboxGeneration = {
      connectionId: '44444444-4444-4444-8444-444444444444',
      partnerId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '66666666-6666-4666-8666-666666666666',
    };

    await enqueueInboundEmail(email, mailboxGeneration);

    expect(addMock).toHaveBeenCalledWith(
      'process',
      { email, mailboxGeneration },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('keeps non-M365 queue jobs compatible without a generation', async () => {
    const mailgunEmail = { ...email, provider: 'mailgun' as const };
    await enqueueInboundEmail(mailgunEmail);

    expect(addMock).toHaveBeenCalledWith(
      'process',
      mailgunEmail,
      expect.anything(),
    );
  });
});

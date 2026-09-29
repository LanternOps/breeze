import { beforeEach, describe, expect, it, vi } from 'vitest';

const emailState = vi.hoisted(() => ({
  service: null as null | { sendEmail: ReturnType<typeof vi.fn> },
}));
vi.mock('./email', () => ({ getEmailService: () => emailState.service }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { emailReportRun, scheduledDeliveryStatus } from './reportDelivery';

const run = {
  reportName: 'Nightly inventory',
  reportType: 'device_inventory',
  format: 'csv',
  recipients: ['ops@example.com'],
  rows: [],
  timezone: 'UTC',
  branding: { name: null, logoDataUrl: null, logoAspect: null },
  partnerId: null,
};

describe('scheduledDeliveryStatus (multi-org report series W01)', () => {
  it.each([
    [{ deliverable: 0, dropped: 0, send: 'not_attempted' }, 'no_recipients'],
    // Every configured address was unusable: still nobody, not "partial".
    [{ deliverable: 0, dropped: 3, send: 'not_attempted' }, 'no_recipients'],
    [{ deliverable: 2, dropped: 0, send: 'sent' }, 'sent'],
    [{ deliverable: 2, dropped: 1, send: 'sent' }, 'partial'],
    [{ deliverable: 2, dropped: 0, send: 'failed' }, 'failed'],
    [{ deliverable: 2, dropped: 1, send: 'failed' }, 'failed'],
    // Recipients existed but nothing was handed to a transport.
    [{ deliverable: 2, dropped: 0, send: 'not_attempted' }, 'failed'],
  ] as const)('%o → %s', (input, expected) => {
    expect(scheduledDeliveryStatus(input)).toBe(expected);
  });
});

describe('emailReportRun hand-off result', () => {
  beforeEach(() => {
    emailState.service = null;
  });

  it('resolves false and sends nothing when no email service is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(emailReportRun(run)).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves true once the transport accepted the message', async () => {
    const sendEmail = vi.fn(async () => undefined);
    emailState.service = { sendEmail };
    await expect(emailReportRun(run)).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('rethrows a transport failure', async () => {
    emailState.service = {
      sendEmail: vi.fn(async () => {
        throw new Error('smtp down');
      }),
    };
    await expect(emailReportRun(run)).rejects.toThrow('smtp down');
  });
});

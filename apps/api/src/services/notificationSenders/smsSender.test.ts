import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTwilioServiceMock = vi.hoisted(() => vi.fn());

vi.mock('../twilio', () => ({
  getTwilioService: getTwilioServiceMock
}));

import { getTwilioService } from '../twilio';
import { sendSmsNotification, validateSmsConfig } from './smsSender';

describe('sms sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates sms config and rejects invalid phone numbers', () => {
    const result = validateSmsConfig({
      phoneNumbers: ['12345']
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Invalid E.164');
  });

  it('fails when sms service is not configured', async () => {
    vi.mocked(getTwilioService).mockReturnValue(null);

    const result = await sendSmsNotification(
      { phoneNumbers: ['+15551234567'] },
      {
        alertName: 'CPU High',
        severity: 'high',
        summary: 'CPU is above threshold'
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SMS service not configured');
  });

  it('sends sms to all configured recipients', async () => {
    const sendSmsMessage = vi.fn().mockResolvedValue({ success: true, messageSid: 'SM123' });
    vi.mocked(getTwilioService).mockReturnValue({
      sendSmsMessage
    } as unknown as ReturnType<typeof getTwilioService>);

    const result = await sendSmsNotification(
      { phoneNumbers: ['+15551234567', '+15557654321'] },
      {
        alertName: 'Disk Critical',
        severity: 'critical',
        summary: 'Disk usage above 98%',
        dashboardUrl: 'https://example.com/alerts/1'
      }
    );

    expect(result.success).toBe(true);
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(sendSmsMessage).toHaveBeenCalledTimes(2);
  });

  it('returns failure when one or more sms sends fail', async () => {
    const sendSmsMessage = vi
      .fn()
      .mockResolvedValueOnce({ success: true, messageSid: 'SM123' })
      .mockResolvedValueOnce({ success: false, error: 'Invalid To number' });

    vi.mocked(getTwilioService).mockReturnValue({
      sendSmsMessage
    } as unknown as ReturnType<typeof getTwilioService>);

    const result = await sendSmsNotification(
      { phoneNumbers: ['+15551234567', '+15557654321'] },
      {
        alertName: 'Memory Alert',
        severity: 'medium',
        summary: 'Memory utilization is high'
      }
    );

    expect(result.success).toBe(false);
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.error).toContain('+15557654321');
  });
});

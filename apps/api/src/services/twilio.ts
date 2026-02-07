import Twilio from 'twilio';

// Twilio error codes for user-correctable phone number issues
const USER_PHONE_ERRORS = new Set([21211, 21614, 21217]); // invalid, landline, not mobile

export interface TwilioSendResult {
  success: boolean;
  error?: string;
  isUserError?: boolean;
}

export interface TwilioCheckResult {
  valid: boolean;
  error?: string;
  serviceError?: boolean;
}

export class TwilioService {
  private client: Twilio.Twilio;
  private verifyServiceSid: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!accountSid || !authToken || !verifyServiceSid) {
      throw new Error('Twilio configuration missing: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID');
    }

    this.client = Twilio(accountSid, authToken);
    this.verifyServiceSid = verifyServiceSid;
  }

  async sendVerificationCode(phoneNumber: string): Promise<TwilioSendResult> {
    try {
      await this.client.verify.v2
        .services(this.verifyServiceSid)
        .verifications.create({ to: phoneNumber, channel: 'sms' });
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send verification code';
      const errorCode = (err as { code?: number })?.code;
      console.error('[twilio] sendVerificationCode error:', { message, errorCode, phoneLast4: phoneNumber.slice(-4) });
      const isUserError = errorCode !== undefined && USER_PHONE_ERRORS.has(errorCode);
      return { success: false, error: message, isUserError };
    }
  }

  async checkVerificationCode(phoneNumber: string, code: string): Promise<TwilioCheckResult> {
    try {
      const check = await this.client.verify.v2
        .services(this.verifyServiceSid)
        .verificationChecks.create({ to: phoneNumber, code });
      return { valid: check.status === 'approved' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to check verification code';
      console.error('[twilio] checkVerificationCode service error:', message);
      // Signal to caller this was a service failure, not an invalid code
      return { valid: false, error: message, serviceError: true };
    }
  }
}

let cachedService: TwilioService | null = null;
let twilioConfigCheckedAt: number = 0;
const TWILIO_RECHECK_INTERVAL_MS = 60_000; // Re-check config every 60s if not available

export function getTwilioService(): TwilioService | null {
  if (cachedService) {
    return cachedService;
  }

  // Avoid checking env vars on every call, but allow re-check periodically
  const now = Date.now();
  if (twilioConfigCheckedAt > 0 && now - twilioConfigCheckedAt < TWILIO_RECHECK_INTERVAL_MS) {
    return null;
  }
  twilioConfigCheckedAt = now;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !verifyServiceSid) {
    console.warn('[twilio] Service not configured: missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_VERIFY_SERVICE_SID');
    return null;
  }

  try {
    cachedService = new TwilioService();
    return cachedService;
  } catch (err) {
    console.error('[twilio] Failed to initialize service:', err);
    return null;
  }
}

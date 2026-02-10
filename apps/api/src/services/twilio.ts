import Twilio from 'twilio';

// Twilio error codes for user-correctable phone number issues
const USER_PHONE_ERRORS = new Set([21211, 21217, 21610, 21614]); // invalid, blocked, landline, not mobile

export type TwilioServiceMode = 'verify' | 'messaging' | 'any';

export interface TwilioSendResult {
  success: boolean;
  error?: string;
  isUserError?: boolean;
}

export interface TwilioSmsSendOptions {
  from?: string;
  messagingServiceSid?: string;
}

export interface TwilioSmsResult {
  success: boolean;
  messageSid?: string;
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
  private verifyServiceSid?: string;
  private defaultMessagingServiceSid?: string;
  private defaultFromPhoneNumber?: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER?.trim();

    if (!accountSid || !authToken) {
      throw new Error('Twilio configuration missing: TWILIO_ACCOUNT_SID and/or TWILIO_AUTH_TOKEN');
    }

    this.client = Twilio(accountSid, authToken);
    this.verifyServiceSid = verifyServiceSid || undefined;
    this.defaultMessagingServiceSid = messagingServiceSid || undefined;
    this.defaultFromPhoneNumber = fromPhoneNumber || undefined;
  }

  hasVerifyConfiguration(): boolean {
    return Boolean(this.verifyServiceSid);
  }

  hasMessagingConfiguration(options?: TwilioSmsSendOptions): boolean {
    return Boolean(options?.messagingServiceSid || options?.from || this.defaultMessagingServiceSid || this.defaultFromPhoneNumber);
  }

  async sendVerificationCode(phoneNumber: string): Promise<TwilioSendResult> {
    if (!this.verifyServiceSid) {
      return {
        success: false,
        error: 'Twilio Verify service not configured'
      };
    }

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
    if (!this.verifyServiceSid) {
      return {
        valid: false,
        error: 'Twilio Verify service not configured',
        serviceError: true
      };
    }

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

  async sendSmsMessage(
    phoneNumber: string,
    message: string,
    options: TwilioSmsSendOptions = {}
  ): Promise<TwilioSmsResult> {
    const messagingServiceSid = options.messagingServiceSid || this.defaultMessagingServiceSid;
    const from = options.from || this.defaultFromPhoneNumber;

    if (!messagingServiceSid && !from) {
      return {
        success: false,
        error: 'Twilio SMS sender is not configured (set messagingServiceSid or from phone number)'
      };
    }

    try {
      const created = await this.client.messages.create({
        to: phoneNumber,
        body: message,
        ...(messagingServiceSid ? { messagingServiceSid } : {}),
        ...(!messagingServiceSid && from ? { from } : {})
      });

      return {
        success: true,
        messageSid: created.sid
      };
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : 'Failed to send SMS message';
      const errorCode = (err as { code?: number })?.code;
      const isUserError = errorCode !== undefined && USER_PHONE_ERRORS.has(errorCode);
      console.error('[twilio] sendSmsMessage error:', { message: messageText, errorCode, phoneLast4: phoneNumber.slice(-4) });
      return {
        success: false,
        error: messageText,
        isUserError
      };
    }
  }
}

let cachedService: TwilioService | null = null;
const twilioConfigCheckedAt: Record<TwilioServiceMode, number> = {
  verify: 0,
  messaging: 0,
  any: 0
};
const TWILIO_RECHECK_INTERVAL_MS = 60_000; // Re-check config every 60s if not available

function getModeMissingMessage(mode: TwilioServiceMode): string {
  switch (mode) {
    case 'verify':
      return 'missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_VERIFY_SERVICE_SID';
    case 'messaging':
      return 'missing TWILIO_ACCOUNT_SID and/or TWILIO_AUTH_TOKEN';
    case 'any':
    default:
      return 'missing TWILIO_ACCOUNT_SID and/or TWILIO_AUTH_TOKEN';
  }
}

function isTwilioConfigured(mode: TwilioServiceMode): boolean {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken) {
    return false;
  }

  if (mode === 'verify') {
    return Boolean(verifyServiceSid);
  }

  if (mode === 'messaging') {
    return true;
  }

  return true;
}

export function getTwilioService(mode: TwilioServiceMode = 'verify'): TwilioService | null {
  if (!isTwilioConfigured(mode)) {
    const now = Date.now();
    if (twilioConfigCheckedAt[mode] > 0 && now - twilioConfigCheckedAt[mode] < TWILIO_RECHECK_INTERVAL_MS) {
      return null;
    }
    twilioConfigCheckedAt[mode] = now;
    console.warn(`[twilio] Service not configured for ${mode}: ${getModeMissingMessage(mode)}`);
    return null;
  }

  twilioConfigCheckedAt[mode] = 0;

  if (cachedService) {
    return cachedService;
  }

  try {
    cachedService = new TwilioService();
    return cachedService;
  } catch (err) {
    console.error('[twilio] Failed to initialize service:', err);
    return null;
  }
}

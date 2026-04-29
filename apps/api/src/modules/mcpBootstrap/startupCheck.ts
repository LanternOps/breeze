import { getEmailService } from '../../services/email.js';

const REQUIRED_ENVS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'BREEZE_BILLING_URL',
  'PUBLIC_ACTIVATION_BASE_URL',
];

export function checkMcpBootstrapStartup(): void {
  const missing = REQUIRED_ENVS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `IS_HOSTED is true but required env vars are missing: ${missing.join(', ')}. ` +
      `Either set these vars or set IS_HOSTED=false.`
    );
  }

  if (!getEmailService()) {
    throw new Error(
      'IS_HOSTED is true but email is not configured. ' +
      'Set EMAIL_PROVIDER + provider creds (RESEND_API_KEY / SMTP_* / MAILGUN_*) and EMAIL_FROM, ' +
      'or set IS_HOSTED=false.'
    );
  }
}

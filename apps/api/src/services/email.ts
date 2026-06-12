import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import {
  escapeHtml,
  getSupportEmail,
  renderButton,
  renderLayout,
} from './emailLayout';

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string | string[];
}

export interface PasswordResetEmailParams {
  to: string | string[];
  name?: string;
  resetUrl: string;
  supportEmail?: string;
}

export interface VerificationEmailParams {
  to: string | string[];
  name?: string;
  verificationUrl: string;
  supportEmail?: string;
}

export interface InviteEmailParams {
  to: string | string[];
  name?: string;
  inviterName?: string;
  orgName?: string;
  inviteUrl: string;
  supportEmail?: string;
}

export interface AccountLockedEmailParams {
  to: string | string[];
  name?: string;
  // Reset link is required (not optional) — the whole point of this email is
  // to give the user a path back in if they're the legitimate owner and the
  // attacker is still firing wrong passwords every few seconds. Without a
  // reset link the user just has to wait 15 minutes hoping nobody tries
  // again, which is a bad experience and bad security.
  resetUrl: string;
  // 15 minutes in this rollout, but pass it explicitly so we can tune the
  // policy in one place (rate-limit.ts) and the email stays in sync.
  lockoutMinutes: number;
  supportEmail?: string;
}

export interface EmailChangedEmailParams {
  to: string | string[];
  name?: string | null;
  newEmail: string;
  supportEmail?: string;
}

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AlertNotificationEmailParams {
  to: string | string[];
  alertName: string;
  severity: AlertSeverity;
  summary: string;
  deviceName?: string;
  occurredAt?: Date | string;
  dashboardUrl?: string;
  orgName?: string;
}

interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

type EmailProvider = 'resend' | 'smtp' | 'mailgun';
type EmailProviderSelection = EmailProvider | 'auto';

type ResendProviderConfig = {
  provider: 'resend';
  apiKey: string;
  from: string;
};

type SmtpProviderConfig = {
  provider: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  pass?: string;
};

type MailgunProviderConfig = {
  provider: 'mailgun';
  apiKey: string;
  domain: string;
  baseUrl: string;
  from: string;
};

type ResolvedProviderConfig = ResendProviderConfig | SmtpProviderConfig | MailgunProviderConfig;

export class EmailService {
  private provider: EmailProvider;
  private resend: Resend | null = null;
  private smtpTransport: Transporter | null = null;
  private mailgunConfig: MailgunProviderConfig | null = null;
  private defaultFrom: string;

  constructor() {
    const config = resolveEmailProviderConfig();
    this.provider = config.provider;
    this.defaultFrom = config.from;

    if (config.provider === 'resend') {
      this.resend = new Resend(config.apiKey);
      return;
    }

    if (config.provider === 'mailgun') {
      this.mailgunConfig = config;
      return;
    }

    this.smtpTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user && config.pass
        ? {
          user: config.user,
          pass: config.pass
        }
        : undefined
    });
  }

  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, subject, html, text, from, replyTo } = params;
    const sender = from ?? this.defaultFrom;

    if (this.provider === 'resend') {
      if (!this.resend) {
        throw new Error('Resend transport is not initialized');
      }

      const { error } = await this.resend.emails.send({
        from: sender,
        to,
        subject,
        html,
        text,
        replyTo
      });
      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }
      return;
    }

    if (this.provider === 'mailgun') {
      if (!this.mailgunConfig) {
        throw new Error('Mailgun config is not initialized');
      }

      await sendViaMailgun(this.mailgunConfig, {
        from: sender,
        to,
        subject,
        html,
        text,
        replyTo
      });
      return;
    }

    if (!this.smtpTransport) {
      throw new Error('SMTP transport is not initialized');
    }

    await this.smtpTransport.sendMail({
      from: sender,
      to,
      subject,
      html,
      text,
      replyTo
    });
  }

  async sendPasswordReset(params: PasswordResetEmailParams): Promise<void> {
    const template = buildPasswordResetTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }

  async sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
    const template = buildVerificationTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }

  async sendInvite(params: InviteEmailParams): Promise<void> {
    const template = buildInviteTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }

  async sendAlertNotification(params: AlertNotificationEmailParams): Promise<void> {
    const template = buildAlertNotificationTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }

  async sendAccountLocked(params: AccountLockedEmailParams): Promise<void> {
    const template = buildAccountLockedTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }

  async sendEmailChanged(params: EmailChangedEmailParams): Promise<void> {
    const template = buildEmailChangedTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
  }
}

let cachedService: EmailService | null = null;
let emailServiceAvailable: boolean | null = null;

/**
 * Get the email service instance.
 * Returns null if email is not configured.
 * This allows graceful degradation - callers should handle null appropriately.
 */
export function getEmailService(): EmailService | null {
  // Check if we've already determined availability
  if (emailServiceAvailable === false) {
    return null;
  }

  if (!cachedService) {
    try {
      cachedService = new EmailService();
      emailServiceAvailable = true;
    } catch (err) {
      emailServiceAvailable = false;
      const reason = err instanceof Error ? err.message : 'unknown error';
      console.warn(`Email service not configured: ${reason}`);
      return null;
    }
  }

  return cachedService;
}

function getEnvString(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEmailProviderSelection(): EmailProviderSelection {
  const raw = (process.env.EMAIL_PROVIDER ?? 'auto').trim().toLowerCase();

  if (raw === 'auto' || raw === 'resend' || raw === 'smtp' || raw === 'mailgun') {
    return raw;
  }

  throw new Error(`EMAIL_PROVIDER must be one of: auto, resend, smtp, mailgun (received "${raw}")`);
}

function parseSmtpPort(): number {
  const raw = getEnvString('SMTP_PORT');
  if (!raw) {
    return 587;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`SMTP_PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }

  return parsed;
}

function parseSmtpSecure(): boolean {
  const raw = getEnvString('SMTP_SECURE');
  if (!raw) {
    return false;
  }

  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`SMTP_SECURE must be a boolean value (received "${raw}")`);
}

function resolveResendConfig(resendApiKey: string | undefined, emailFrom: string | undefined): ResendProviderConfig {
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }
  if (!emailFrom) {
    throw new Error('EMAIL_FROM is not set');
  }

  return {
    provider: 'resend',
    apiKey: resendApiKey,
    from: emailFrom
  };
}

function resolveSmtpConfig(
  smtpHost: string | undefined,
  smtpFrom: string | undefined,
  smtpUser: string | undefined,
  smtpPass: string | undefined
): SmtpProviderConfig {
  if (!smtpHost) {
    throw new Error('SMTP_HOST is not set');
  }
  if (!smtpFrom) {
    throw new Error('SMTP_FROM (or EMAIL_FROM fallback) is not set');
  }
  if ((smtpUser && !smtpPass) || (!smtpUser && smtpPass)) {
    throw new Error('SMTP_USER and SMTP_PASS must either both be set or both be omitted');
  }

  return {
    provider: 'smtp',
    host: smtpHost,
    port: parseSmtpPort(),
    secure: parseSmtpSecure(),
    from: smtpFrom,
    user: smtpUser,
    pass: smtpPass
  };
}

function resolveMailgunConfig(
  mailgunApiKey: string | undefined,
  mailgunDomain: string | undefined,
  mailgunBaseUrl: string | undefined,
  mailgunFrom: string | undefined
): MailgunProviderConfig {
  if (!mailgunApiKey) {
    throw new Error('MAILGUN_API_KEY is not set');
  }
  if (!mailgunDomain) {
    throw new Error('MAILGUN_DOMAIN is not set');
  }
  if (!mailgunFrom) {
    throw new Error('MAILGUN_FROM (or EMAIL_FROM fallback) is not set');
  }

  return {
    provider: 'mailgun',
    apiKey: mailgunApiKey,
    domain: mailgunDomain,
    baseUrl: normalizeBaseUrl(mailgunBaseUrl ?? 'https://api.mailgun.net'),
    from: mailgunFrom
  };
}

function resolveEmailProviderConfig(): ResolvedProviderConfig {
  const selection = parseEmailProviderSelection();
  const resendApiKey = getEnvString('RESEND_API_KEY');
  const emailFrom = getEnvString('EMAIL_FROM');
  const smtpHost = getEnvString('SMTP_HOST');
  const smtpFrom = getEnvString('SMTP_FROM') ?? emailFrom;
  const smtpUser = getEnvString('SMTP_USER');
  const smtpPass = process.env.SMTP_PASS && process.env.SMTP_PASS.length > 0
    ? process.env.SMTP_PASS
    : undefined;
  const mailgunApiKey = getEnvString('MAILGUN_API_KEY');
  const mailgunDomain = getEnvString('MAILGUN_DOMAIN');
  const mailgunBaseUrl = getEnvString('MAILGUN_BASE_URL');
  const mailgunFrom = getEnvString('MAILGUN_FROM') ?? emailFrom;

  if (selection === 'resend') {
    return resolveResendConfig(resendApiKey, emailFrom);
  }

  if (selection === 'smtp') {
    return resolveSmtpConfig(smtpHost, smtpFrom, smtpUser, smtpPass);
  }

  if (selection === 'mailgun') {
    return resolveMailgunConfig(mailgunApiKey, mailgunDomain, mailgunBaseUrl, mailgunFrom);
  }

  if (resendApiKey && emailFrom) {
    return resolveResendConfig(resendApiKey, emailFrom);
  }

  if (smtpHost && smtpFrom) {
    return resolveSmtpConfig(smtpHost, smtpFrom, smtpUser, smtpPass);
  }

  if (mailgunApiKey && mailgunDomain && mailgunFrom) {
    return resolveMailgunConfig(mailgunApiKey, mailgunDomain, mailgunBaseUrl, mailgunFrom);
  }

  throw new Error(
    'Set EMAIL_PROVIDER=resend with RESEND_API_KEY and EMAIL_FROM, EMAIL_PROVIDER=smtp with SMTP_HOST and SMTP_FROM, or EMAIL_PROVIDER=mailgun with MAILGUN_API_KEY and MAILGUN_DOMAIN (EMAIL_FROM/MAILGUN_FROM required)'
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildMailgunEndpoint(config: MailgunProviderConfig): string {
  return `${config.baseUrl}/v3/${encodeURIComponent(config.domain)}/messages`;
}

async function sendViaMailgun(
  config: MailgunProviderConfig,
  params: SendEmailParams & { from: string }
): Promise<void> {
  const body = new URLSearchParams();
  body.set('from', params.from);
  body.set('subject', params.subject);

  const recipients = Array.isArray(params.to) ? params.to : [params.to];
  for (const recipient of recipients) {
    body.append('to', recipient);
  }

  if (params.text) {
    body.set('text', params.text);
  }
  body.set('html', params.html);

  if (params.replyTo) {
    const replyTos = Array.isArray(params.replyTo) ? params.replyTo : [params.replyTo];
    for (const replyTo of replyTos) {
      body.append('h:Reply-To', replyTo);
    }
  }

  const authToken = Buffer.from(`api:${config.apiKey}`).toString('base64');
  const response = await fetch(buildMailgunEndpoint(config), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    const details = message ? `: ${message}` : '';
    throw new Error(`Mailgun API error (${response.status})${details}`);
  }
}

const BODY_PARA = 'margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #1f2937;';
const MUTED_PARA = 'margin: 12px 0 0; font-size: 13px; line-height: 1.55; color: #6b7280;';

function supportFooter(explicit: string | undefined, prefix: string): string | undefined {
  const support = getSupportEmail(explicit);
  return support ? `${prefix} ${support}.` : undefined;
}

function buildPasswordResetTemplate(params: PasswordResetEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const subject = 'Reset your Breeze password';
  const preheader = 'Use the link below to set a new Breeze password.';
  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">A password reset was requested for your Breeze account. Use the button below to set a new one.</p>
      ${renderButton('Reset password', params.resetUrl)}
      <p style="${MUTED_PARA}">If you did not request this, you can safely ignore this email.</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Reset your password',
    body,
    footer: supportFooter(params.supportEmail, 'Need help? Contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    'A password reset was requested for your Breeze account.',
    `Reset your password: ${params.resetUrl}`,
    'If you did not request this, you can safely ignore this email.',
    support ? `Need help? Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function buildVerificationTemplate(params: VerificationEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const subject = 'Verify your email for Breeze RMM';
  const preheader = 'Confirm your email address to finish setting up Breeze.';
  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">Welcome to Breeze. Please confirm your email address so we can finish setting up your account.</p>
      ${renderButton('Verify email', params.verificationUrl)}
      <p style="${MUTED_PARA}">This link expires in 24 hours. If you did not sign up for Breeze, you can safely ignore this email.</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Verify your email',
    body,
    footer: supportFooter(params.supportEmail, 'Need help? Contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    'Welcome to Breeze. Please confirm your email address so we can finish setting up your account.',
    `Verify your email: ${params.verificationUrl}`,
    'This link expires in 24 hours. If you did not sign up for Breeze, you can safely ignore this email.',
    support ? `Need help? Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function buildInviteTemplate(params: InviteEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const inviter = params.inviterName?.trim() || 'A teammate';
  const orgName = params.orgName?.trim();
  const subject = orgName
    ? `${inviter} invited you to ${orgName} on Breeze`
    : `${inviter} invited you to Breeze`;
  const preheader = orgName
    ? `Accept your invitation to ${orgName} on Breeze.`
    : 'Accept your invitation to Breeze.';
  const heading = orgName ? `Join ${orgName}` : 'You are invited';

  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">${escapeHtml(inviter)} invited you${orgName ? ` to ${escapeHtml(orgName)}` : ''} on Breeze.</p>
      ${renderButton('Accept invitation', params.inviteUrl)}
      <p style="${MUTED_PARA}">This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.</p>
  `;

  const html = renderLayout({
    title: heading,
    preheader,
    heading,
    body,
    footer: supportFooter(params.supportEmail, 'Questions? Contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    `${inviter} invited you${orgName ? ` to ${orgName}` : ''} on Breeze.`,
    `Accept invitation: ${params.inviteUrl}`,
    "This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.",
    support ? `Questions? Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function buildAlertNotificationTemplate(params: AlertNotificationEmailParams): EmailTemplate {
  const severityLabel = params.severity.toUpperCase();
  const subject = `Alert ${severityLabel}: ${params.alertName}`;
  const timestamp = formatTimestamp(params.occurredAt);
  const { bg: pillBg, fg: pillFg } = alertSeverityPalette(params.severity);
  const preheader = [
    severityLabel,
    params.deviceName ? `on ${params.deviceName}` : null,
    timestamp ? `at ${timestamp}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const details = [
    params.deviceName ? `Device: ${params.deviceName}` : null,
    `Severity: ${severityLabel}`,
    timestamp ? `Detected: ${timestamp}` : null,
  ].filter(Boolean) as string[];

  const body = `
      <p style="margin: 0 0 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.6px; text-transform: none;">
        <span style="display: inline-block; padding: 4px 10px; border-radius: 999px; background: ${pillBg}; color: ${pillFg}; font-size: 12px; letter-spacing: 0.6px;">${severityLabel}</span>
      </p>
      <p style="${BODY_PARA}">${escapeHtml(params.summary)}</p>
      <div style="margin: 12px 0 16px; padding: 12px 14px; border-radius: 8px; background: #f7fafc;">
        ${details
    .map((detail) => `<p style="margin: 0 0 6px; font-size: 13px; line-height: 1.5; color: #374151;">${escapeHtml(detail)}</p>`)
    .join('')}
      </div>
      ${params.dashboardUrl ? renderButton('View details', params.dashboardUrl) : ''}
  `;

  const orgSupport = params.orgName ? `${params.orgName} support` : 'Breeze support';
  const html = renderLayout({
    title: params.alertName,
    preheader,
    heading: params.alertName,
    body,
    footer: `If you have questions, contact ${orgSupport}.`,
  });

  const text = [
    `${params.alertName} (${severityLabel})`,
    params.summary,
    params.deviceName ? `Device: ${params.deviceName}` : undefined,
    timestamp ? `Detected: ${timestamp}` : undefined,
    params.dashboardUrl ? `View details: ${params.dashboardUrl}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function buildAccountLockedTemplate(params: AccountLockedEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const subject = 'Your Breeze account was temporarily locked';
  const preheader = `We locked sign-ins for ${params.lockoutMinutes} minutes after repeated failed attempts.`;
  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">We blocked sign-ins to your Breeze account after 5 unsuccessful attempts. You can try again in ${params.lockoutMinutes} minutes, or reset your password using the button below.</p>
      ${renderButton('Reset password', params.resetUrl)}
      <p style="${MUTED_PARA}"><strong>If this wasn't you</strong>, someone may be trying to guess your password. Reset your password immediately and review recent activity. If MFA isn't already enabled on your account, turn it on after you sign back in.</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Account temporarily locked',
    body,
    footer: supportFooter(params.supportEmail, 'Need help? Contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    `We blocked sign-ins to your Breeze account after 5 unsuccessful attempts. Try again in ${params.lockoutMinutes} minutes, or reset your password.`,
    `Reset your password: ${params.resetUrl}`,
    "If this wasn't you, someone may be trying to guess your password. Reset your password immediately and review recent activity.",
    support ? `Need help? Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function buildEmailChangedTemplate(params: EmailChangedEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const subject = 'Your Breeze account email was changed';
  const preheader = `The email on your Breeze account was changed to ${params.newEmail}.`;
  const body = `
      <p style="${BODY_PARA}">Hi ${escapeHtml(name)},</p>
      <p style="${BODY_PARA}">Your Breeze account email was changed to <strong>${escapeHtml(params.newEmail)}</strong>.</p>
      <p style="${MUTED_PARA}"><strong>If you did not make this change</strong>, your account may be compromised. Contact support immediately to secure it.</p>
  `;
  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Account email changed',
    body,
    footer: supportFooter(params.supportEmail, 'If you did not make this change, contact'),
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    `Hi ${name},`,
    `Your Breeze account email was changed to ${params.newEmail}.`,
    'If you did not make this change, your account may be compromised. Contact support immediately to secure it.',
    support ? `Contact ${support}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function formatTimestamp(value?: Date | string): string | null {
  if (!value) {
    return null;
  }

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatted = date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${formatted} UTC`;
}

function alertSeverityPalette(severity: AlertSeverity): { bg: string; fg: string } {
  switch (severity) {
    case 'critical':
      return { bg: '#dc2626', fg: '#ffffff' };
    case 'high':
      return { bg: '#c2410c', fg: '#ffffff' };
    case 'medium':
      return { bg: '#fde68a', fg: '#78350f' };
    case 'low':
      return { bg: '#1d4ed8', fg: '#ffffff' };
    case 'info':
    default:
      return { bg: '#475569', fg: '#ffffff' };
  }
}

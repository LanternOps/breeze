import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';

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

export interface InviteEmailParams {
  to: string | string[];
  name?: string;
  inviterName?: string;
  orgName?: string;
  inviteUrl: string;
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

      await this.resend.emails.send({
        from: sender,
        to,
        subject,
        html,
        text,
        reply_to: replyTo
      });
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

function buildPasswordResetTemplate(params: PasswordResetEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const support = params.supportEmail ?? 'support@breeze.local';
  const subject = 'Reset your Breeze password';
  const body = `
      <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
        Hi ${escapeHtml(name)},
      </p>
      <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
        We received a request to reset your Breeze password. Use the button below to set a new one.
      </p>
      ${renderButton('Reset password', params.resetUrl)}
      <p style="margin: 16px 0 0; font-size: 14px; color: #4a5568;">
        If you did not request this, you can safely ignore this email.
      </p>
  `;
  const html = renderLayout({
    title: subject,
    body,
    footer: `Need help? Contact ${support}.`
  });

  const text = [
    `Hi ${name},`,
    'We received a request to reset your Breeze password.',
    `Reset your password: ${params.resetUrl}`,
    'If you did not request this, you can safely ignore this email.',
    `Need help? Contact ${support}.`
  ].join('\n');

  return { subject, html, text };
}

function buildInviteTemplate(params: InviteEmailParams): EmailTemplate {
  const name = params.name?.trim() || 'there';
  const inviter = params.inviterName?.trim() || 'A teammate';
  const orgName = params.orgName?.trim();
  const support = params.supportEmail ?? 'support@breeze.local';
  const subject = orgName
    ? `${inviter} invited you to join ${orgName} in Breeze`
    : `${inviter} invited you to Breeze`;

  const body = `
      <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
        Hi ${escapeHtml(name)},
      </p>
      <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
        ${escapeHtml(inviter)} invited you${orgName ? ` to join ${escapeHtml(orgName)}` : ''} in Breeze.
      </p>
      ${renderButton('Accept invitation', params.inviteUrl)}
      <p style="margin: 16px 0 0; font-size: 14px; color: #4a5568;">
        This invitation will expire after 7 days.
      </p>
  `;

  const html = renderLayout({
    title: 'You are invited',
    body,
    footer: `Questions? Contact ${support}.`
  });

  const text = [
    `Hi ${name},`,
    `${inviter} invited you${orgName ? ` to join ${orgName}` : ''} in Breeze.`,
    `Accept invitation: ${params.inviteUrl}`,
    'This invitation will expire after 7 days.',
    `Questions? Contact ${support}.`
  ].join('\n');

  return { subject, html, text };
}

function buildAlertNotificationTemplate(params: AlertNotificationEmailParams): EmailTemplate {
  const severityLabel = params.severity.toUpperCase();
  const subject = `Alert ${severityLabel}: ${params.alertName}`;
  const support = params.orgName ? `${params.orgName} support` : 'Breeze support';
  const timestamp = formatTimestamp(params.occurredAt);
  const severityColor = alertSeverityColor(params.severity);
  const details = [
    params.deviceName ? `Device: ${params.deviceName}` : null,
    `Severity: ${severityLabel}`,
    timestamp ? `Detected: ${timestamp}` : null
  ].filter(Boolean);

  const body = `
      <p style="margin: 0 0 12px; font-size: 16px; color: #1d2735;">
        ${escapeHtml(params.summary)}
      </p>
      <div style="margin: 0 0 16px; padding: 12px; border-radius: 8px; background: #f7fafc;">
        ${details
      .map(
        (detail) =>
          `<p style="margin: 0 0 6px; font-size: 14px; color: #2d3748;">${escapeHtml(detail ?? '')}</p>`
      )
      .join('')}
        <span style="display: inline-block; margin-top: 6px; padding: 4px 10px; border-radius: 999px; background: ${severityColor}; color: #ffffff; font-size: 12px; letter-spacing: 0.5px;">
          ${severityLabel}
        </span>
      </div>
      ${params.dashboardUrl ? renderButton('View alert details', params.dashboardUrl) : ''}
  `;

  const html = renderLayout({
    title: 'Alert notification',
    body,
    footer: `If you have questions, contact ${support}.`
  });

  const text = [
    `${params.alertName} (${severityLabel})`,
    params.summary,
    params.deviceName ? `Device: ${params.deviceName}` : undefined,
    timestamp ? `Detected: ${timestamp}` : undefined,
    params.dashboardUrl ? `View details: ${params.dashboardUrl}` : undefined
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function renderLayout(options: { title: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #eef2f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #eef2f7; padding: 24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: #ffffff; border-radius: 12px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);">
            <tr>
              <td style="padding: 28px 32px 8px;">
                <h1 style="margin: 0; font-size: 22px; color: #111827; font-weight: 600;">
                  ${escapeHtml(options.title)}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 32px 24px;">
                ${options.body}
              </td>
            </tr>
            <tr>
              <td style="padding: 0 32px 24px;">
                <p style="margin: 0; font-size: 12px; color: #6b7280;">
                  ${escapeHtml(options.footer)}
                </p>
              </td>
            </tr>
          </table>
          <p style="margin: 16px 0 0; font-size: 12px; color: #94a3b8;">
            Breeze RMM
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderButton(label: string, url: string): string {
  return `
    <a
      href="${escapeHtml(url)}"
      style="display: inline-block; padding: 12px 20px; border-radius: 8px; background: #0f172a; color: #ffffff; font-size: 14px; text-decoration: none;"
    >
      ${escapeHtml(label)}
    </a>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value?: Date | string): string | null {
  if (!value) {
    return null;
  }

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function alertSeverityColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return '#dc2626';
    case 'high':
      return '#f97316';
    case 'medium':
      return '#eab308';
    case 'low':
      return '#3b82f6';
    case 'info':
    default:
      return '#64748b';
  }
}

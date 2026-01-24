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

export class EmailService {
  private resend: Resend;
  private defaultFrom: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;

    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not set');
    }
    if (!from) {
      throw new Error('EMAIL_FROM is not set');
    }

    this.resend = new Resend(apiKey);
    this.defaultFrom = from;
  }

  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, subject, html, text, from, replyTo } = params;

    await this.resend.emails.send({
      from: from ?? this.defaultFrom,
      to,
      subject,
      html,
      text,
      reply_to: replyTo
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
 * Returns null if email is not configured (missing RESEND_API_KEY or EMAIL_FROM).
 * This allows graceful degradation - callers should handle null appropriately.
 */
export function getEmailService(): EmailService | null {
  // Check if we've already determined availability
  if (emailServiceAvailable === false) {
    return null;
  }

  if (!cachedService) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;

    if (!apiKey || !from) {
      emailServiceAvailable = false;
      console.warn('Email service not configured: missing RESEND_API_KEY or EMAIL_FROM');
      return null;
    }

    try {
      cachedService = new EmailService();
      emailServiceAvailable = true;
    } catch (err) {
      emailServiceAvailable = false;
      console.error('Failed to initialize email service:', err);
      return null;
    }
  }

  return cachedService;
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

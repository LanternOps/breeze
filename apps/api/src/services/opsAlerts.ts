import { safeFetch } from './urlSafety';
import { getEmailService } from './email';
import { captureException } from './sentry';

export interface OpsAlertMessage {
  title: string;
  body: string;
}

const DISCORD_CONTENT_LIMIT = 2000;
const WEBHOOK_TIMEOUT_MS = 10_000;
let warnedUnconfigured = false;

export function isOpsAlertingConfigured(): boolean {
  return Boolean(process.env.OPS_ALERT_WEBHOOK_URL || process.env.OPS_ALERT_EMAIL);
}

function formatContent(msg: OpsAlertMessage): string {
  const label = process.env.OPS_ALERT_LABEL?.trim();
  const title = label ? `[${label}] ${msg.title}` : msg.title;
  return `**${title}**\n${msg.body}`.slice(0, DISCORD_CONTENT_LIMIT);
}

async function sendWebhook(url: string, msg: OpsAlertMessage): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const response = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Breeze-RMM/1.0' },
      body: JSON.stringify({ content: formatContent(msg) }),
      signal: controller.signal,
      redirect: 'error',
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error(`[OpsAlerts] Webhook responded ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[OpsAlerts] Webhook delivery failed:', error instanceof Error ? error.message : error);
    captureException(error);
    return false;
  }
}

async function sendOpsEmail(to: string, msg: OpsAlertMessage): Promise<boolean> {
  const email = getEmailService();
  if (!email) {
    console.warn('[OpsAlerts] OPS_ALERT_EMAIL set but email service not configured');
    return false;
  }
  try {
    await email.sendEmail({
      to,
      subject: `[Breeze ops] ${msg.title}`,
      text: msg.body,
      html: `<pre>${msg.body.replace(/</g, '&lt;')}</pre>`,
    });
    return true;
  } catch (error) {
    console.error('[OpsAlerts] Email delivery failed:', error instanceof Error ? error.message : error);
    captureException(error);
    return false;
  }
}

/** Delivers to every configured channel; true if at least one succeeded. Never throws. */
export async function sendOpsAlert(msg: OpsAlertMessage): Promise<boolean> {
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
  const emailTo = process.env.OPS_ALERT_EMAIL?.trim();
  if (!webhookUrl && !emailTo) {
    if (!warnedUnconfigured) {
      console.warn('[OpsAlerts] No OPS_ALERT_WEBHOOK_URL or OPS_ALERT_EMAIL configured — ops alerts disabled');
      warnedUnconfigured = true;
    }
    return false;
  }
  const results = await Promise.all([
    webhookUrl ? sendWebhook(webhookUrl, msg) : Promise.resolve(false),
    emailTo ? sendOpsEmail(emailTo, msg) : Promise.resolve(false),
  ]);
  return results.some(Boolean);
}

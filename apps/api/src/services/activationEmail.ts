import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { getEmailService } from './email';

export interface BuildActivationEmailInput {
  activationUrl: string;
  orgName: string;
}

export interface SendActivationEmailArgs {
  to: string;
  rawToken: string;
  partnerId: string;
}

export function buildActivationEmail({ activationUrl, orgName }: BuildActivationEmailInput) {
  const safeOrg = escapeHtml(orgName);
  const subject = `Activate your Breeze tenant for ${orgName}`;
  const text = [
    `Welcome to Breeze!`,
    ``,
    `Click the link below to activate ${orgName}'s tenant (link valid 24 hours):`,
    ``,
    activationUrl,
    ``,
    `After clicking, you'll be asked to attach a payment method for identity verification (no charge for free tier).`,
    ``,
    `— Breeze`,
  ].join('\n');
  const html = [
    `<p>Welcome to <strong>Breeze</strong>!</p>`,
    `<p>Click the link below to activate <strong>${safeOrg}</strong>'s tenant (link valid 24 hours):</p>`,
    `<p><a href="${escapeHtml(activationUrl)}">${escapeHtml(activationUrl)}</a></p>`,
    `<p>After clicking, you'll be asked to attach a payment method for identity verification (no charge for free tier).</p>`,
    `<p>— Breeze</p>`,
  ].join('');
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

export async function sendActivationEmail(input: SendActivationEmailArgs): Promise<void> {
  const base = process.env.PUBLIC_ACTIVATION_BASE_URL;
  if (!base) throw new Error('PUBLIC_ACTIVATION_BASE_URL is not configured.');
  const [partner] = await db
    .select({ name: partners.name })
    .from(partners)
    .where(eq(partners.id, input.partnerId))
    .limit(1);
  const orgName = partner?.name ?? 'your organization';
  const tmpl = buildActivationEmail({
    activationUrl: `${base}/activate/${input.rawToken}`,
    orgName,
  });
  const svc = getEmailService();
  if (!svc) throw new Error('Email service is not configured.');
  await svc.sendEmail({ to: input.to, ...tmpl });
}

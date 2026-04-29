import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { getEmailService } from './email';
import {
  escapeHtml,
  getSupportEmail,
  renderButton,
  renderLayout,
} from './emailLayout';

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
  const subject = `Activate Breeze for ${orgName}`;
  const preheader = `Confirm your account in 24 hours to start using Breeze.`;
  const support = getSupportEmail();

  const text = [
    'Welcome to Breeze.',
    '',
    `To finish setting up Breeze for ${orgName}, activate your account using the link below. The link is valid for 24 hours.`,
    '',
    `Activate: ${activationUrl}`,
    '',
    "After activating, you'll be asked to add a payment method. Stripe uses this to verify your identity. You won't be charged now.",
    '',
    "If you weren't expecting this email, you can safely ignore it.",
    support ? '' : null,
    support ? `Questions? Contact ${support}.` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const body = `
      <p style="margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #1f2937;">Welcome to Breeze.</p>
      <p style="margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #1f2937;">To finish setting up Breeze for <strong>${safeOrg}</strong>, activate your account using the button below. The link is valid for 24 hours.</p>
      ${renderButton('Activate account', activationUrl)}
      <p style="margin: 16px 0 0; font-size: 13px; line-height: 1.55; color: #6b7280;">After activating, you'll be asked to add a payment method. Stripe uses this to verify your identity. You won't be charged now.</p>
      <p style="margin: 12px 0 0; font-size: 13px; line-height: 1.55; color: #6b7280;">If you weren't expecting this email, you can safely ignore it.</p>
  `;

  const html = renderLayout({
    title: subject,
    preheader,
    heading: 'Activate your Breeze account',
    body,
    footer: support ? `Questions? Contact ${support}.` : undefined,
  });

  return { subject, html, text };
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

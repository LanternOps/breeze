/**
 * Email template for the MCP bootstrap flow's `send_deployment_invites` tool.
 *
 * Pure template builder, no DB or network. The optional `customMessage`
 * originates from an untrusted MCP client, so it goes through an HTML tag
 * stripper and a 500-character clamp before either body sees it.
 */

import { escapeHtml, renderButton, renderLayout } from './emailLayout';

export interface DeploymentInviteEmailInput {
  orgName: string;
  adminEmail: string;
  installUrl: string;
  customMessage?: string;
}

export interface DeploymentInviteEmailTemplate {
  subject: string;
  html: string;
  text: string;
}

function sanitizeCustomMessage(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/<[^>]+>/g, '').slice(0, 500);
}

export function buildDeploymentInviteEmail(
  input: DeploymentInviteEmailInput,
): DeploymentInviteEmailTemplate {
  const subject = `${input.orgName} wants to install Breeze on your device`;
  const preheader = 'Quick install (under 60 seconds). Mac, Windows, or Linux supported.';
  const safeMsg = sanitizeCustomMessage(input.customMessage);

  const textLines = [
    'Hi,',
    '',
    `${input.adminEmail} from ${input.orgName} is asking you to install Breeze, a monitoring tool that keeps your device secure and performant.`,
    '',
    `Install: ${input.installUrl}`,
    '',
    'The install takes under 60 seconds and detects your operating system automatically. Mac, Windows, and Linux are supported. Your device password will be required.',
  ];
  if (safeMsg) {
    textLines.push('', `Note from ${input.adminEmail}:`, safeMsg);
  }
  textLines.push(
    '',
    "If you weren't expecting this, reply to this email and we'll help.",
    '',
    `Sent on behalf of ${input.orgName} by Breeze.`,
  );
  const text = textLines.join('\n');

  const safeOrg = escapeHtml(input.orgName);
  const safeAdmin = escapeHtml(input.adminEmail);
  const messageBlock = safeMsg
    ? `<div style="margin: 16px 0; padding: 12px 14px; border-radius: 8px; background: #f7fafc;"><p style="margin: 0 0 6px; font-size: 12px; line-height: 1.5; color: #6b7280;">Note from ${safeAdmin}</p><p style="margin: 0; font-size: 14px; line-height: 1.55; color: #1f2937; white-space: pre-wrap;">${escapeHtml(safeMsg)}</p></div>`
    : '';

  const body = `
      <p style="margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #1f2937;">Hi,</p>
      <p style="margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #1f2937;"><strong>${safeAdmin}</strong> from <strong>${safeOrg}</strong> is asking you to install <strong>Breeze</strong>, a monitoring tool that keeps your device secure and performant.</p>
      ${renderButton('Install Breeze', input.installUrl)}
      <p style="margin: 16px 0 0; font-size: 13px; line-height: 1.55; color: #6b7280;">The install takes under 60 seconds and detects your operating system automatically. Mac, Windows, and Linux are supported. Your device password will be required.</p>
      ${messageBlock}
      <p style="margin: 12px 0 0; font-size: 13px; line-height: 1.55; color: #6b7280;">If you weren't expecting this, reply to this email and we'll help.</p>
  `;

  const html = renderLayout({
    title: 'Install Breeze',
    preheader,
    heading: 'Install Breeze',
    body,
    footer: `Sent on behalf of ${input.orgName} by Breeze.`,
  });

  return { subject, html, text };
}

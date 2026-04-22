/**
 * Email template for the MCP bootstrap flow's `send_deployment_invites` tool.
 *
 * Pure template builder — no DB, no network, no side effects. Accepts a
 * recipient-neutral shape (orgName / adminEmail / installUrl) plus an optional
 * admin-supplied custom message. The custom message is passed through an HTML
 * tag stripper and clamped to 500 characters before it lands in either the
 * HTML or text body, because it originates from an untrusted MCP client.
 */

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip HTML tags and clamp to 500 characters. Keeps the text content of any
 * markup a caller may have pasted in but denies the ability to inject script
 * tags or tracking pixels into the outbound email.
 */
function sanitizeCustomMessage(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/<[^>]+>/g, '').slice(0, 500);
}

export function buildDeploymentInviteEmail(
  input: DeploymentInviteEmailInput,
): DeploymentInviteEmailTemplate {
  const subject = `[${input.orgName}] Install your device monitoring agent`;
  const safeMsg = sanitizeCustomMessage(input.customMessage);

  const textLines = [
    'Hi,',
    '',
    `Your IT admin (${input.adminEmail}) has set up Breeze, a monitoring agent that keeps your device secure and performant.`,
    '',
    `→ Install now: ${input.installUrl}`,
    '',
    'The install takes <60 seconds and detects your OS automatically. Mac, Windows, and Linux supported. Admin password will be required on your machine.',
  ];
  if (safeMsg) {
    textLines.push('', safeMsg);
  }
  textLines.push('', 'Questions? Reply to this email.', '', `— Breeze, for ${input.orgName}`);
  const text = textLines.join('\n');

  const parts = [
    '<p>Hi,</p>',
    `<p>Your IT admin (${escapeHtml(input.adminEmail)}) has set up <strong>Breeze</strong>, a monitoring agent that keeps your device secure and performant.</p>`,
    `<p><a href="${escapeHtml(input.installUrl)}">→ Install now</a></p>`,
    '<p>The install takes &lt;60 seconds and detects your OS automatically. Mac, Windows, and Linux supported. Admin password will be required on your machine.</p>',
  ];
  if (safeMsg) parts.push(`<p>${escapeHtml(safeMsg)}</p>`);
  parts.push('<p>Questions? Reply to this email.</p>');
  parts.push(`<p>— Breeze, for ${escapeHtml(input.orgName)}</p>`);
  const html = parts.join('');

  return { subject, html, text };
}

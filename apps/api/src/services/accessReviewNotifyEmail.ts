import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';

export interface AccessReviewNotifyContext {
  reviewName: string;
  dueDate: Date | null;
  appBaseUrl: string;
}

export function buildAccessReviewNotifyEmail(ctx: AccessReviewNotifyContext): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Access review: ${ctx.reviewName}`;
  const deadline = ctx.dueDate
    ? `Please complete it by ${ctx.dueDate.toISOString().slice(0, 10)}.`
    : 'There is no deadline set.';
  const message = `You have been asked to complete the access review "${ctx.reviewName}". ${deadline}`;
  const url = `${ctx.appBaseUrl.replace(/\/$/, '')}/settings/access-reviews`;
  const text = [message, '', `Open access reviews: ${url}`].join('\n');
  const body = [
    renderParagraph(escapeHtml(message)),
    renderButton('Open access reviews', url),
    renderParagraph('You receive this because you are the assigned reviewer in Breeze.', { muted: true, marginTop: 16 }),
  ].join('\n');
  const html = renderLayout({ title: subject, preheader: message.slice(0, 120), heading: subject, body });
  return { subject, html, text };
}

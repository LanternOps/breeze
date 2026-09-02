import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';

export interface AiBudgetAlertContext {
  orgName: string;
  period: 'daily' | 'monthly';
  periodKey: string;
  thresholdPct: number;
  capCents: number;
  usedCents: number;
  billingSource: 'platform' | 'partner_key';
  usagePath: string;
  appBaseUrl: string;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function periodResetLabel(period: 'daily' | 'monthly', periodKey: string): string {
  const [y, m, d] = periodKey.split('-').map(Number) as [number, number, number];
  const next = period === 'monthly' ? new Date(Date.UTC(y, m, 1)) : new Date(Date.UTC(y, m - 1, d + 1));
  const day = next.getUTCDate();
  const mon = next.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${day} ${mon} ${next.getUTCFullYear()} 00:00 UTC`;
}

/** Spec section 4.5: daily pre-cap rungs are in-app only. */
export function shouldEmail(period: 'daily' | 'monthly', thresholdPct: number): boolean {
  return period === 'monthly' || thresholdPct >= 100;
}

function billedTo(source: AiBudgetAlertContext['billingSource']): string {
  return source === 'partner_key' ? 'Billed to your Anthropic API key.' : 'Billed to Breeze AI credits.';
}

export function describeAiBudgetAlert(ctx: AiBudgetAlertContext): { title: string; message: string } {
  const reached = ctx.thresholdPct >= 100;
  const title = reached
    ? `AI budget reached for ${ctx.orgName} (${ctx.period})`
    : `AI budget at ${ctx.thresholdPct}% for ${ctx.orgName} (${ctx.period})`;
  const spend = `${usd(ctx.usedCents)} of ${usd(ctx.capCents)} used this ${ctx.period === 'daily' ? 'day' : 'month'}; resets ${periodResetLabel(ctx.period, ctx.periodKey)}.`;
  const message = reached
    ? `${spend} AI features are paused for this organization until the period resets or the cap is raised. ${billedTo(ctx.billingSource)}`
    : `${spend} ${billedTo(ctx.billingSource)}`;
  return { title, message };
}

export function buildAiBudgetAlertEmail(ctx: AiBudgetAlertContext): { subject: string; html: string; text: string } {
  const { title, message } = describeAiBudgetAlert(ctx);
  const url = `${ctx.appBaseUrl}${ctx.usagePath}`;
  const text = [title, '', message, '', `Review usage and budget: ${url}`].join('\n');
  const body = [
    renderParagraph(escapeHtml(message)),
    renderButton('Review AI usage', url),
    renderParagraph('You receive this because you can manage billing for this organization in Breeze.', { muted: true, marginTop: 16 }),
  ].join('\n');
  const html = renderLayout({ title, preheader: message.slice(0, 120), heading: escapeHtml(title), body });
  return { subject: title, html, text };
}

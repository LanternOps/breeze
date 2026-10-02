import type { BillingNoticeKind } from '@breeze/shared';
import { escapeHtml } from '../emailLayout';
import { renderPartnerEmail, type RenderPartnerEmailArgs } from '../emailTemplates/renderPartnerEmail';
import type { RenderedNotice } from './types';

export interface BillingNoticeContext {
  partnerId: string;
  orgId: string;
  data: Record<string, unknown>;
  frozen: Record<string, string | number | null>;
  mandatory: { skipUrl?: string; stopUrl?: string; feeDisclosure?: string; achAuthorizationReference?: string };
}

export type BillingNoticeRenderer = (ctx: BillingNoticeContext) => Promise<{
  email: Omit<RenderPartnerEmailArgs, 'bodyBeforeCta' | 'bodyAfterCta'>;
  text: string;
}>;

const renderers = new Map<BillingNoticeKind, BillingNoticeRenderer>();

export function registerBillingNoticeRenderer(kind: BillingNoticeKind, renderer: BillingNoticeRenderer): void {
  if (renderers.has(kind)) throw new Error(`Billing renderer already registered: ${kind}`);
  renderers.set(kind, renderer);
}

function checkedUrl(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Unsafe billing URL');
  }
  return value;
}

export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice> {
  const renderer = renderers.get(kind);
  if (!renderer) throw new Error(`No billing renderer: ${kind}`);

  const rendered = await renderer(ctx);
  const html: string[] = [];
  const text: string[] = [];
  for (const value of [ctx.mandatory.feeDisclosure, ctx.mandatory.achAuthorizationReference]) {
    if (value) {
      html.push(`<p>${escapeHtml(value)}</p>`);
      text.push(value);
    }
  }
  for (const [label, raw] of [
    ['Skip this invoice', ctx.mandatory.skipUrl],
    ['Stop automatic payments', ctx.mandatory.stopUrl],
  ] as const) {
    if (!raw) continue;
    const url = checkedUrl(raw);
    html.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`);
    text.push(`${label}: ${url}`);
  }

  const email = renderPartnerEmail({ ...rendered.email, bodyBeforeCta: undefined, bodyAfterCta: html.join('') });
  return { ...email, text: [rendered.text, ...text].filter(Boolean).join('\n\n'), frozen: { ...ctx.frozen } };
}

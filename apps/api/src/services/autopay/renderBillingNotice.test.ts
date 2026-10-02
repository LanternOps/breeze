import { describe, expect, it, vi } from 'vitest';
import type { BillingNoticeKind } from '@breeze/shared';
import type { RenderPartnerEmailArgs } from '../emailTemplates/renderPartnerEmail';
const { renderedArgs } = vi.hoisted(() => ({ renderedArgs: vi.fn() }));
vi.mock('../emailTemplates/renderPartnerEmail', () => ({
  renderPartnerEmail: (args: RenderPartnerEmailArgs) => {
    renderedArgs(args);
    return { subject: 'Frozen subject', html: `${args.custom?.html ?? ''}${args.bodyAfterCta ?? ''}` };
  },
}));
import { renderBillingNotice, registerBillingNoticeRenderer, type BillingNoticeContext } from './renderBillingNotice';

const ctx: BillingNoticeContext = { partnerId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', data: {},
  frozen: { amount: '100.00', date: '2026-10-20' },
  mandatory: { skipUrl: 'https://portal.example.test/skip', stopUrl: 'https://portal.example.test/stop',
    feeDisclosure: 'Fee < $3', achAuthorizationReference: 'Mandate <reference>' } };
describe('billing renderer registry', () => {
  it('starts with no production renderers', async () => {
    await expect(renderBillingNotice('card_expiring', ctx)).rejects.toThrow('No billing renderer');
  });
  it('appends escaped mandatory copy outside a fully replaced editable body', async () => {
    const fakeKind = 'test_only' as BillingNoticeKind;
    registerBillingNoticeRenderer(fakeKind, async () => ({
      email: { id: 'invoice_send', vars: {}, custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Partner replacement</p>' } },
      text: 'Partner text',
    }));
    const result = await renderBillingNotice(fakeKind, ctx);
    expect(result.html).toContain('<p>Partner replacement</p>');
    expect(result.html).toContain('Fee &lt; $3');
    expect(result.html).toContain('Mandate &lt;reference&gt;');
    expect(result.html).toContain('https://portal.example.test/skip');
    expect(result.html).toContain('https://portal.example.test/stop');
    expect(result.text).toContain('Fee < $3');
    expect(result.text).toContain('Stop automatic payments: https://portal.example.test/stop');
    expect(result.frozen).toEqual(ctx.frozen);
    expect(result.frozen).not.toBe(ctx.frozen);
    expect(renderedArgs).toHaveBeenCalledWith(expect.objectContaining({ bodyAfterCta: expect.stringContaining('Stop automatic payments') }));
    await expect(renderBillingNotice(fakeKind, { ...ctx, mandatory: { stopUrl: 'javascript:alert(1)' } })).rejects.toThrow('Unsafe billing URL');
    expect(() => registerBillingNoticeRenderer(fakeKind, async () => ({ email: { id: 'invoice_send', vars: {} }, text: '' }))).toThrow('already registered');
  });
});

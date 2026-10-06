import { describe, expect, it, vi } from 'vitest';
import { EMAIL_TEMPLATE_IDS, varsForEmailTemplate, emailTemplateFieldDefaults } from '@breeze/shared';
const h = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => ({ db: { select: () => ({ from: () => ({
  where: () => ({ limit: async () => h.rows.shift() ?? [] }),
}) }) } }));
import { renderAutopayNotice } from './enrollmentNotices';
const ctx = {
  orgId: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  vars: { client_name: 'Accounts team', partner_name: 'Example MSP', org_name: 'Example client',
    setup_link: 'https://portal.example.test/autopay/token', ach_mode_text: 'Bank account or card' },
  ctaUrl: 'https://portal.example.test/autopay/token',
  scheduleText: 'Invoices are charged 5 days after issue or on the due date, whichever is later.',
  feeText: 'No processing fee applies.', stopUrl: 'https://portal.example.test/autopay/stop-token/stop',
};
describe('enrollment notices', () => {
  it.each([
    ['autopay_request', ['client_name', 'setup_link', 'ach_mode_text']],
    ['autopay_enrolled', ['client_name', 'payment_method', 'schedule_text', 'fee_text']],
    ['autopay_stopped', ['client_name', 'stopped_by', 'open_invoices_text']],
    ['card_expiring', ['client_name', 'payment_method', 'expires_on', 'update_link']],
  ] as const)('registers the closed %s catalog', (id, keys) => {
    expect(EMAIL_TEMPLATE_IDS).toContain(id);
    expect(varsForEmailTemplate(id)).toEqual(['partner_name', 'org_name', ...(id === 'autopay_request' || id === 'card_expiring' ? ['cta_button'] : []), ...keys]);
    expect(emailTemplateFieldDefaults(id).html).not.toBe('');
  });
  it('keeps the terms table and the stop link outside a custom body, and states each once', async () => {
    h.rows.push([{ settings: { emailTemplates: { autopay_enrolled: { html: '<p>Hello only</p>' } } } }]);
    const out = await renderAutopayNotice('autopay_enrolled', { ...ctx,
      summary: [{ label: "When you're charged", value: "On each invoice's due date" }, { label: 'Processing fee', value: 'No fee' }],
      terms: { title: 'Your authorization', paragraphs: ['I authorize Example MSP to save this card.'] } });
    expect(out.html).toContain('Hello only');
    expect(out.html).toContain('>When you&#39;re charged</td>');
    expect(out.html).toContain(ctx.stopUrl);
    for (const line of [`Stop automatic payments: ${ctx.stopUrl}`, "When you're charged: On each invoice's due date", 'I authorize Example MSP to save this card.']) {
      expect(out.text.split(line).length - 1, line).toBe(1);
    }
    // The schedule and fee sentences are recorded, not printed again (D-9).
    expect(out.text).not.toContain(ctx.scheduleText);
    expect(out.frozen).toMatchObject({ scheduleText: ctx.scheduleText, feeText: ctx.feeText });
  });
  it('escapes client-controlled text even in immutable blocks', async () => {
    h.rows.push([{ settings: {} }]);
    const out = await renderAutopayNotice('autopay_request', { ...ctx,
      summary: [{ label: 'When', value: '<img src=x onerror=alert(1)>' }], stopUrl: 'javascript:alert(1)' });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('href="javascript:');
    expect(out.html).toContain('&lt;img');
  });
});

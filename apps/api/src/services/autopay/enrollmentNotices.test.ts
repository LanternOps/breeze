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
  it('keeps schedule, stop and fee disclosures outside a custom body', async () => {
    h.rows.push([{ settings: { emailTemplates: { autopay_request: { html: '<p>Hello only</p>' } } } }]);
    const out = await renderAutopayNotice('autopay_request', ctx);
    expect(out.html).toContain('Hello only');
    expect(out.html).toContain(ctx.scheduleText);
    expect(out.html).toContain(ctx.feeText);
    expect(out.html).toContain(ctx.stopUrl);
    expect(out.text).toContain(ctx.scheduleText);
    expect(out.text).toContain(ctx.stopUrl);
    expect(out.frozen).toMatchObject({ scheduleText: ctx.scheduleText, feeText: ctx.feeText });
  });
  it('escapes client-controlled text even in immutable blocks', async () => {
    h.rows.push([{ settings: {} }]);
    const out = await renderAutopayNotice('autopay_request', { ...ctx,
      scheduleText: '<img src=x onerror=alert(1)>', stopUrl: 'javascript:alert(1)' });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('href="javascript:');
    expect(out.html).toContain('&lt;img');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPartnerEmail, type RenderPartnerEmailArgs } from './renderPartnerEmail';

const PORTAL_HREF = 'https://manage.example/portal/tickets/abc';

function commentArgs(overrides: Partial<RenderPartnerEmailArgs> = {}): RenderPartnerEmailArgs {
  return {
    id: 'ticket_comment_notification',
    vars: {},
    ctaUrl: PORTAL_HREF,
    internalNumber: 'T-2026-0001',
    ticketSubject: 'Printer is down',
    ...overrides,
  };
}

describe('renderPartnerEmail', () => {
  it('wraps default comment mail in layout with accent, sentence, and CTA href', () => {
    const out = renderPartnerEmail(commentArgs());
    expect(out.subject).toBe('[T-2026-0001] New reply: Printer is down');
    expect(out.html).toContain('<!doctype html>');
    expect(out.html).toContain('#155e75');
    expect(out.html).toContain('Your ticket has a new reply. Sign in to the portal to view it.');
    expect(out.html).toContain(`href="${PORTAL_HREF}"`);
  });

  it('substitutes {{ticket_number}} in custom html', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Hi {{ticket_number}}</p>' },
      vars: { ticket_number: 'T-1' },
    }));
    expect(out.html).toContain('T-1');
  });

  it('strips <script> and HTML-escapes merge values', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: '<script>alert(1)</script><p>Hi {{requester_name}}</p>',
      },
      vars: { requester_name: 'Ada <x>' },
    }));
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('Ada &lt;x&gt;');
    expect(out.html).not.toContain('Ada <x>');
  });

  it('does not leave javascript: in href after a poisoned merge var', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: '<a href="{{ticket_subject}}">x</a>',
      },
      vars: { ticket_subject: 'javascript:alert(1)' },
      ctaUrl: undefined,
    }));
    expect(out.html).not.toContain('javascript:');
    expect(out.html).not.toMatch(/href\s*=\s*["']javascript:/i);
  });

  it('renders {{comment}} and {{agent_name}} empty even when those keys are passed', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: '<p>X{{comment}}Y{{agent_name}}Z</p>',
      },
      vars: { comment: 'SECRET', agent_name: 'Eve', ticket_number: 'T-1' },
    }));
    expect(out.html).toContain('XYZ');
    expect(out.html).not.toContain('SECRET');
    expect(out.html).not.toContain('Eve');
  });

  it('includes filled email_only_hint text', () => {
    const hint = 'If you do not have a portal account, reply to this email instead.';
    const out = renderPartnerEmail(commentArgs({ vars: { email_only_hint: hint } }));
    expect(out.html).toContain(hint);
    expect(out.html).not.toContain('{{email_only_hint}}');
  });

  it('does not leave the email_only_hint token when the var is empty', () => {
    const out = renderPartnerEmail(commentArgs({ vars: { email_only_hint: '' } }));
    expect(out.html).not.toContain('{{email_only_hint}}');
  });

  it('keeps the default sentence when custom is null', () => {
    const out = renderPartnerEmail(commentArgs({ custom: null }));
    expect(out.html).toContain('Your ticket has a new reply. Sign in to the portal to view it.');
  });

  it('renders autoresponse inbound fallback body inside layout', () => {
    const out = renderPartnerEmail({
      id: 'ticket_autoresponse',
      custom: null,
      vars: { requester_name: 'Ada' },
      internalNumber: 'T-2026-0001',
      ticketSubject: 'Printer is down',
      inboundAutoresponseFallback: { subject: null, body: 'Hello {{requester_name}}' },
    });
    expect(out.html).toContain('<!doctype html>');
    expect(out.html).toContain('Hello Ada');
  });

  it('escapes script tags in autoresponse inbound fallback body', () => {
    const out = renderPartnerEmail({
      id: 'ticket_autoresponse',
      custom: null,
      vars: {},
      inboundAutoresponseFallback: { subject: null, body: 'Hi <script>alert(1)</script>' },
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('substitutes {{resolution_note}} and never imports ticket_comments', () => {
    const out = renderPartnerEmail({
      id: 'ticket_resolved',
      vars: { resolution_note: 'Replaced the roller' },
      ctaUrl: PORTAL_HREF,
      internalNumber: 'T-2026-0001',
      ticketSubject: 'Printer is down',
    });
    expect(out.subject).toBe('[T-2026-0001] Resolved: Printer is down');
    expect(out.html).toContain('Replaced the roller');
    expect(out.html).not.toContain('{{resolution_note}}');

    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/ticketComments|ticket_comments/);
    }
  });

  it('omits the button when ctaUrl is javascript:', () => {
    const out = renderPartnerEmail(commentArgs({ ctaUrl: 'javascript:alert(1)' }));
    expect(out.html).not.toContain('javascript:');
  });

  it('does not splice the CTA button into an attribute value', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: '<p><a href="{{cta_button}}">click</a></p>',
      },
    }));
    expect(out.html).not.toMatch(/href="[^"]*<a[\s>]/i);
    expect(out.html).not.toContain('%%BREEZE_CTA_BUTTON%%');
    expect(out.html).toContain(`href="${PORTAL_HREF}"`);
  });

  it('omits the empty resolution_note paragraph from default resolved mail', () => {
    const out = renderPartnerEmail({
      id: 'ticket_resolved',
      vars: { resolution_note: '' },
      ctaUrl: PORTAL_HREF,
      internalNumber: 'T-2026-0001',
      ticketSubject: 'Printer is down',
    });
    expect(out.html).toContain('Your ticket has been resolved.');
    expect(out.html).not.toContain('<p></p>');
    expect(out.html).toContain(`href="${PORTAL_HREF}"`);
  });

  it('appends the CTA when hasCta html omits {{cta_button}}', () => {
    const out = renderPartnerEmail(commentArgs({
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Thanks for waiting.</p>' },
    }));
    expect(out.html).toContain('Thanks for waiting.');
    expect(out.html).toContain(`href="${PORTAL_HREF}"`);
    expect(out.html).toContain('View ticket');
  });
});

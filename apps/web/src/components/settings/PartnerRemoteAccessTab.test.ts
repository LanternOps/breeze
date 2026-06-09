import { describe, it, expect } from 'vitest';

import { urlTemplateError } from './PartnerRemoteAccessTab';

// #714 / #680: the inline URL-template validation must mirror the server's
// scheme guard so a partner admin gets immediate feedback on a blocked scheme
// (e.g. javascript:) instead of only finding out on save.
describe('urlTemplateError', () => {
  it('returns null for an empty template (no error until the user types)', () => {
    expect(urlTemplateError('')).toBeNull();
  });

  it('flags a template with no scheme', () => {
    expect(urlTemplateError('rustdesk{id}')).toMatch(/scheme/i);
    expect(urlTemplateError('//acme.example.com/{id}')).toMatch(/scheme/i);
  });

  it('mirrors the server denylist — rejects dangerous schemes inline', () => {
    expect(urlTemplateError('javascript:alert(1)')).toMatch(/not permitted|blocked|allowed/i);
    expect(urlTemplateError('data:text/html,<script>')).toMatch(/not permitted|blocked|allowed/i);
    expect(urlTemplateError('file:///etc/passwd')).toMatch(/not permitted|blocked|allowed/i);
  });

  it('accepts allowlisted and custom non-dangerous schemes', () => {
    expect(urlTemplateError('rustdesk://{id}?password={password}')).toBeNull();
    expect(urlTemplateError('https://acme.example.com/Host#Access///{id}/Join')).toBeNull();
    expect(urlTemplateError('bdunn-rustremote://{id}')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../email', () => ({
  getEmailService: vi.fn(() => null)
}));

import { validateEmailConfig } from './emailSender';

describe('validateEmailConfig recipients (#12148)', () => {
  it.each([
    ['empty recipients array', { recipients: [] }],
    ['empty "to" array', { to: [] }],
    ['empty recipients string', { recipients: '' }],
    ['whitespace-only recipients string', { recipients: '   ' }],
    ['array holding only an empty string', { recipients: [''] }],
    ['array holding only whitespace', { recipients: ['  '] }],
    ['valid address alongside a blank entry', { recipients: ['ops@example.com', ''] }],
    ['missing recipients', {}]
  ])('rejects %s', (_label, config) => {
    const result = validateEmailConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('explains that at least one recipient is required for an empty array', () => {
    expect(validateEmailConfig({ recipients: [] }).errors).toEqual([
      'At least one recipient is required'
    ]);
  });

  it.each([
    ['a recipients array', { recipients: ['ops@example.com', 'noc@example.com'] }],
    ['a recipients string', { recipients: 'ops@example.com' }],
    ['the "to" alias', { to: ['ops@example.com'] }]
  ])('accepts %s', (_label, config) => {
    expect(validateEmailConfig(config)).toEqual({ valid: true, errors: [] });
  });
});

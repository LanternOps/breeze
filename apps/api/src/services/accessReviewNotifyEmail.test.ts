import { describe, it, expect } from 'vitest';
import { buildAccessReviewNotifyEmail } from './accessReviewNotifyEmail';

describe('buildAccessReviewNotifyEmail', () => {
  const base = {
    reviewName: 'Q4 <b>review</b>',
    dueDate: new Date('2026-10-16T00:00:00.000Z'),
    appBaseUrl: 'https://app.example.com'
  };

  it('names the review, deadline and links to the access reviews page', () => {
    const e = buildAccessReviewNotifyEmail(base);
    expect(e.subject).toContain('Q4 <b>review</b>');
    expect(e.text).toContain('2026-10-16');
    expect(e.text).toContain('https://app.example.com/settings/access-reviews');
  });

  it('escapes the review name in html', () => {
    const e = buildAccessReviewNotifyEmail(base);
    expect(e.html).not.toContain('<b>review</b>');
    expect(e.html).toContain('&lt;b&gt;review&lt;/b&gt;');
  });

  it('states when no deadline is set', () => {
    const e = buildAccessReviewNotifyEmail({ ...base, dueDate: null });
    expect(e.text).toMatch(/no deadline/i);
  });
});

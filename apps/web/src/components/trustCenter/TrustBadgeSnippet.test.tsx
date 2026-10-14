// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
vi.mock('@/lib/api/trustPage', () => ({ trustPublicUrl: (p: string) => `https://breeze.test${p}` }));
vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => (k.endsWith('badge.alt') ? 'Say "hi" <b> & co' : k) }) };
});
import TrustBadgeSnippet, { escapeHtmlAttr } from './TrustBadgeSnippet';

describe('TrustBadgeSnippet', () => {
  it('escapes the alt text so a quote cannot break the attribute', () => {
    render(<TrustBadgeSnippet publicPath="/portal/trust/a/b" badgePath="/api/v1/trust/public/a/b/badge.svg" published />);
    const v = (screen.getByTestId('trust-badge-snippet') as HTMLTextAreaElement).value;
    expect(v).toContain('alt="Say &quot;hi&quot; &lt;b&gt; &amp; co"');
    expect(v.match(/"/g)).toHaveLength(6);
  });
  it('escapeHtmlAttr handles all four characters', () => {
    expect(escapeHtmlAttr('&"<>')).toBe('&amp;&quot;&lt;&gt;');
  });
});

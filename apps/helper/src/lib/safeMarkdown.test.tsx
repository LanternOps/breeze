// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeMarkdownImage, SafeMarkdownLink, isSafeHttpUrl } from './safeMarkdown';

describe('isSafeHttpUrl', () => {
  it.each(['https://example.com/x.png', 'http://example.com/x.png'])('accepts %s', (url) => {
    expect(isSafeHttpUrl(url)).toBe(true);
  });

  it.each([undefined, null, '', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//example.com/x.png', '/relative.png'])(
    'rejects %s',
    (url) => {
      expect(isSafeHttpUrl(url as string | undefined | null)).toBe(false);
    },
  );
});

describe('SafeMarkdownImage', () => {
  it('never renders an <img> element, even for a safe http(s) source', () => {
    const { container } = render(<SafeMarkdownImage src="https://collector.example/beacon?d=secret" alt="chart" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a safe http(s) source as a click-through link', () => {
    const { getByRole } = render(<SafeMarkdownImage src="https://collector.example/beacon?d=secret" alt="chart" />);
    const link = getByRole('link', { name: 'chart' });
    expect(link).toHaveAttribute('href', 'https://collector.example/beacon?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders an unsafe source (javascript:, data:) as inert text, not a link', () => {
    const { container, queryByRole } = render(<SafeMarkdownImage src="javascript:alert(document.cookie)" alt="payload" />);
    expect(queryByRole('link')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('payload');
  });
});

describe('SafeMarkdownLink', () => {
  it('keeps an http(s) href', () => {
    const { getByRole } = render(<SafeMarkdownLink href="https://example.com/page">click me</SafeMarkdownLink>);
    expect(getByRole('link', { name: 'click me' })).toHaveAttribute('href', 'https://example.com/page');
  });

  it('neutralizes a javascript: href to #', () => {
    const { getByRole } = render(<SafeMarkdownLink href="javascript:alert(1)">click me</SafeMarkdownLink>);
    expect(getByRole('link', { name: 'click me' })).toHaveAttribute('href', '#');
  });

  it('neutralizes a data: href to #', () => {
    const { getByRole } = render(<SafeMarkdownLink href="data:text/html,x">click me</SafeMarkdownLink>);
    expect(getByRole('link', { name: 'click me' })).toHaveAttribute('href', '#');
  });
});

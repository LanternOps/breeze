import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeMarkdownImage, isSafeHttpUrl } from './safeMarkdownImage';

describe('isSafeHttpUrl', () => {
  it.each(['https://example.com/x.png', 'http://example.com/x.png'])(
    'accepts %s',
    (url) => {
      expect(isSafeHttpUrl(url)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    '',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//example.com/x.png',
    '/relative.png',
  ])('rejects %s', (url) => {
    expect(isSafeHttpUrl(url as string | undefined | null)).toBe(false);
  });
});

describe('SafeMarkdownImage', () => {
  it('never renders an <img> element, even for a safe http(s) source', () => {
    const { container } = render(
      <SafeMarkdownImage src="https://collector.example/beacon?d=secret" alt="chart" />,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a safe http(s) source as a click-through link', () => {
    const { getByRole } = render(
      <SafeMarkdownImage src="https://collector.example/beacon?d=secret" alt="chart" />,
    );
    const link = getByRole('link', { name: 'chart' });
    expect(link).toHaveAttribute('href', 'https://collector.example/beacon?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders an unsafe source (javascript:, data:) as inert text, not a link', () => {
    const { container, queryByRole } = render(
      <SafeMarkdownImage src="javascript:alert(document.cookie)" alt="payload" />,
    );
    expect(queryByRole('link')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('payload');
  });
});

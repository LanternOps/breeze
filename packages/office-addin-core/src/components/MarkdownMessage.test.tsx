import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MarkdownMessage } from './MarkdownMessage';

afterEach(cleanup);

describe('MarkdownMessage', () => {
  it('renders **bold** markdown as a <strong> in the DOM', () => {
    const { container } = render(<MarkdownMessage text="Hello **world**" />);
    expect(container.querySelector('strong')?.textContent).toBe('world');
  });

  it('renders a list as <ul><li> elements', () => {
    const { container } = render(<MarkdownMessage text={'- a\n- b'} />);
    expect(container.querySelector('ul')).toBeTruthy();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a table as a <table>', () => {
    const { container } = render(
      <MarkdownMessage text={'| A | B |\n| - | - |\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th')).toHaveLength(2);
  });

  it('sanitizes a <script> tag out of the rendered DOM', () => {
    const { container } = render(
      <MarkdownMessage text={'safe <script>window.__pwned = 1</script> text'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__pwned).toBeUndefined();
  });

  it('passes through className and testId', () => {
    const { container } = render(
      <MarkdownMessage text="hi" className="prose" testId="md" />,
    );
    const el = container.querySelector('[data-testid="md"]');
    expect(el).toBeTruthy();
    expect(el?.className).toContain('prose');
  });

  it('does not crash on partial/incomplete markdown (streaming chunk)', () => {
    expect(() =>
      render(<MarkdownMessage text={'| A | B\nhalf **bol'} />),
    ).not.toThrow();
  });

  it('re-renders cleanly as streamed text grows', () => {
    const { container, rerender } = render(<MarkdownMessage text="Loading" />);
    rerender(<MarkdownMessage text="Loading **the** report" />);
    expect(container.querySelector('strong')?.textContent).toBe('the');
  });
});

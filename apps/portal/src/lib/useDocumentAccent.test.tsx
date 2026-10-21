// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useDocumentAccent } from './useDocumentAccent';

function Host({ color }: { color: string | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useDocumentAccent(ref, color);
  return <div ref={ref} data-testid="host" />;
}

describe('useDocumentAccent', () => {
  afterEach(() => document.documentElement.style.removeProperty('--doc-accent'));

  it('sets --doc-accent on the wrapper for a valid colour', () => {
    const { getByTestId } = render(<Host color="#0a7c5c" />);
    expect(getByTestId('host').style.getPropertyValue('--doc-accent')).toBe('#0a7c5c');
  });

  it('a hostile value leaves no --doc-accent', () => {
    const { getByTestId } = render(<Host color="red;background:url(x)" />);
    expect(getByTestId('host').style.getPropertyValue('--doc-accent')).toBe('');
    expect(getByTestId('host').getAttribute('style') ?? '').not.toContain('url(');
  });

  it('never touches <html>', () => {
    render(<Host color="#0a7c5c" />);
    expect(document.documentElement.style.getPropertyValue('--doc-accent')).toBe('');
  });

  it('updates when the colour changes and removes it when cleared', () => {
    const { getByTestId, rerender } = render(<Host color="#0a7c5c" />);
    rerender(<Host color="#112233" />);
    expect(getByTestId('host').style.getPropertyValue('--doc-accent')).toBe('#112233');
    rerender(<Host color={null} />);
    expect(getByTestId('host').style.getPropertyValue('--doc-accent')).toBe('');
  });
});

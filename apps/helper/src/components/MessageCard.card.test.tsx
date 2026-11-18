// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/*
 * #10190 W04 (spec 3.5): the message card and the prompt card are one
 * component. MessageCard.test.tsx (unchanged) pins that the message card
 * looks and behaves as before; this file pins that it is drawn by Card.
 */

const cardSpy = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('../prompt/Card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt/Card')>();
  return {
    ...actual,
    Card: (props: Parameters<typeof actual.Card>[0]) => {
      cardSpy.calls.push(props as unknown as Record<string, unknown>);
      return actual.Card(props);
    },
  };
});

import { MessageCard, type MessageView } from './MessageCard';

const view: MessageView = {
  messageId: '11111111-1111-4111-8111-111111111111',
  title: 'Maintenance tonight',
  body: 'Please save your work.',
  severity: 'warning',
  requiresAck: true,
  expiresAt: '2030-01-01T00:00:00Z',
  branding: { companyName: 'Example IT', displayName: 'Example', accent: '#336699' },
  plain: false,
};

describe('MessageCard', () => {
  it('MessageCard renders through Card', () => {
    const { container } = render(<MessageCard view={view} onAcknowledge={() => {}} onClose={() => {}} />);
    expect(cardSpy.calls).toHaveLength(1);
    expect(cardSpy.calls[0]!.variant).toBe('message');
    // The card root is Card's, with the message card's own classes and role.
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('data-card', 'message');
    expect(root).toHaveClass('helper-message-card', 'is-warning');
    expect(root).toHaveAttribute('role', 'alertdialog');
    expect(root).toHaveAttribute('aria-label', 'Maintenance tonight');
    expect(screen.getByTestId('message-sender')).toHaveTextContent('From Example IT');
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleClosing } from './LifecycleClosing';

describe('LifecycleClosing', () => {
  it('names the contact and mentions email when both are present', () => {
    render(<LifecycleClosing contactEmail="msp@example.com" contactName="Jamie" />);
    expect(screen.getByTestId('lifecycle-closing')).toHaveTextContent(
      'To approve or discuss this plan, contact Jamie (msp@example.com). We will send quotes for the "Now" group first.',
    );
  });

  it('falls back to the email alone when there is no contact name', () => {
    render(<LifecycleClosing contactEmail="msp@example.com" />);
    expect(screen.getByTestId('lifecycle-closing')).toHaveTextContent(
      'To approve or discuss this plan, contact msp@example.com. We will send quotes for the "Now" group first.',
    );
  });

  it('renders nothing when there is no contact email', () => {
    const { container } = render(<LifecycleClosing contactName="Jamie" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('lifecycle-closing')).toBeNull();
  });
});

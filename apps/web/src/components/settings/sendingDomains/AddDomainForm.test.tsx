import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddDomainForm from './AddDomainForm';

describe('AddDomainForm', () => {
  it('shows the subdomain recommendation and all three reasons in the empty state', () => {
    render(<AddDomainForm disabled={false} showRecommendation onAdd={vi.fn()} />);
    const block = screen.getByTestId('sending-domains-recommendation');
    expect(block.textContent).toContain('We recommend a dedicated subdomain');
    expect(block.textContent).toContain('sending reputation');
    expect(block.textContent).toContain('never take a domain away from another account');
    expect(block.textContent).toContain('exact-match rule');
  });

  it('hides the recommendation once the partner already has a domain', () => {
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);
    expect(screen.queryByTestId('sending-domains-recommendation')).toBeNull();
  });

  it('normalises with the shared validator before calling onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={onAdd} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), '  MAIL.Acme.COM. ');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(onAdd).toHaveBeenCalledWith('mail.acme.com');
  });

  it('refuses a structurally invalid domain client-side and never calls onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={onAdd} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), 'https://acme.com');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-domains-add-error').textContent)
      .toBe('Enter a domain such as mail.yourcompany.com.');
  });

  it('clears the inline error once the field is edited again', async () => {
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), 'localhost');
    await user.click(screen.getByTestId('sending-domains-add-submit'));
    expect(screen.getByTestId('sending-domains-add-error')).not.toBeNull();

    await user.type(screen.getByTestId('sending-domains-add-input'), '.example');
    expect(screen.queryByTestId('sending-domains-add-error')).toBeNull();
  });

  it('disables the input and the button while the tab is busy', () => {
    render(<AddDomainForm disabled showRecommendation={false} onAdd={vi.fn()} />);
    expect((screen.getByTestId('sending-domains-add-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-domains-add-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('empties the field after a successful add', async () => {
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);
    const input = screen.getByTestId('sending-domains-add-input') as HTMLInputElement;

    await user.type(input, 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(input.value).toBe('');
  });
});

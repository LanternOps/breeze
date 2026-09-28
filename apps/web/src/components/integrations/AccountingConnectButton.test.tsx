import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AccountingConnectButton from './AccountingConnectButton';

describe('AccountingConnectButton', () => {
  it('QuickBooks renders the existing primary button (test id and label unchanged)', () => {
    render(<AccountingConnectButton provider="quickbooks" reconnect={false} busy={false} disabled={false} onClick={vi.fn()} />);
    const btn = screen.getByTestId('quickbooks-connect');
    expect(btn.className).toContain('bg-primary');
    expect(btn.textContent).toContain('Connect to QuickBooks');
    expect(btn.getAttribute('data-brand')).toBeNull();
  });

  it('Xero renders the certification-style branded button', () => {
    render(<AccountingConnectButton provider="xero" reconnect={false} busy={false} disabled={false} onClick={vi.fn()} />);
    const btn = screen.getByTestId('xero-connect');
    expect(btn.getAttribute('data-brand')).toBe('xero');
    expect(btn.textContent).toContain('Connect to Xero');
  });

  it('reconnect wording', () => {
    render(<AccountingConnectButton provider="xero" reconnect busy={false} disabled={false} onClick={vi.fn()} />);
    expect(screen.getByTestId('xero-connect').textContent).toContain('Reconnect Xero');
  });

  it('disables while busy or disabled and fires onClick', () => {
    const onClick = vi.fn();
    const { rerender } = render(<AccountingConnectButton provider="xero" reconnect={false} busy={false} disabled={false} onClick={onClick} />);
    screen.getByTestId('xero-connect').click();
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<AccountingConnectButton provider="xero" reconnect={false} busy={true} disabled={false} onClick={onClick} />);
    expect(screen.getByTestId('xero-connect')).toBeDisabled();

    rerender(<AccountingConnectButton provider="xero" reconnect={false} busy={false} disabled={true} onClick={onClick} />);
    expect(screen.getByTestId('xero-connect')).toBeDisabled();
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PartnerCompanyTab from './PartnerCompanyTab';
import type { PartnerSettings } from '@breeze/shared';

type Address = NonNullable<PartnerSettings['address']>;
type Contact = NonNullable<PartnerSettings['contact']>;

function renderTab(overrides?: {
  name?: string;
  address?: Address;
  contact?: Contact;
  emailSignature?: string;
}) {
  const onNameChange = vi.fn();
  const onAddressChange = vi.fn();
  const onContactChange = vi.fn();
  const onEmailSignatureChange = vi.fn();
  render(
    <PartnerCompanyTab
      name={overrides?.name ?? 'Acme MSP'}
      address={overrides?.address ?? {}}
      contact={overrides?.contact ?? {}}
      emailSignature={overrides?.emailSignature ?? ''}
      onNameChange={onNameChange}
      onAddressChange={onAddressChange}
      onContactChange={onContactChange}
      onEmailSignatureChange={onEmailSignatureChange}
    />
  );
  return { onNameChange, onAddressChange, onContactChange, onEmailSignatureChange };
}

describe('PartnerCompanyTab', () => {
  it('renders all four sections', () => {
    renderTab();
    expect(screen.getByText('Company')).not.toBeNull();
    expect(screen.getByText('Address')).not.toBeNull();
    expect(screen.getByText('Contact')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Email Signature' })).not.toBeNull();
  });

  it('renders the current company name and fires onNameChange', () => {
    const { onNameChange } = renderTab({ name: 'Acme MSP' });
    const input = screen.getByLabelText(/company name/i) as HTMLInputElement;
    expect(input.value).toBe('Acme MSP');
    fireEvent.change(input, { target: { value: 'Acme MSP Inc.' } });
    expect(onNameChange).toHaveBeenCalledWith('Acme MSP Inc.');
  });

  it('renders address fields and fires onAddressChange when a field changes', () => {
    const { onAddressChange } = renderTab({
      address: { street1: '123 Main St', city: 'Denver', country: 'US' },
    });
    const street1 = screen.getByLabelText(/street 1/i) as HTMLInputElement;
    expect(street1.value).toBe('123 Main St');
    fireEvent.change(street1, { target: { value: '456 Oak Ave' } });
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ street1: '456 Oak Ave', city: 'Denver', country: 'US' })
    );
  });

  it('fires onAddressChange with a new country when the dropdown changes', () => {
    const { onAddressChange } = renderTab({ address: { country: 'US' } });
    const country = screen.getByLabelText(/country/i) as HTMLSelectElement;
    fireEvent.change(country, { target: { value: 'CA' } });
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'CA' })
    );
  });

  it('renders contact fields and fires onContactChange', () => {
    const { onContactChange } = renderTab({
      contact: { name: 'Jane Doe', email: 'jane@example.com' },
    });
    const email = screen.getByLabelText(/^email$/i) as HTMLInputElement;
    expect(email.value).toBe('jane@example.com');
    fireEvent.change(email, { target: { value: 'jane@acme.com' } });
    expect(onContactChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Jane Doe', email: 'jane@acme.com' })
    );
  });

  it('renders the saved email signature and fires onEmailSignatureChange', () => {
    const { onEmailSignatureChange } = renderTab({
      emailSignature: 'Best regards,\nAcme MSP',
    });
    const textarea = screen.getByTestId('partner-email-signature') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Best regards,\nAcme MSP');
    expect(textarea.maxLength).toBe(2000);
    expect(
      screen.getByText('Appended to proposal emails sent to your customers.')
    ).not.toBeNull();
    fireEvent.change(textarea, { target: { value: 'Cheers,\nAcme' } });
    expect(onEmailSignatureChange).toHaveBeenCalledWith('Cheers,\nAcme');
  });
});

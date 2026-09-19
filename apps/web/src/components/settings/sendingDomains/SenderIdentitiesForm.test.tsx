import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SenderIdentityDto, SendingDomainDto } from '@breeze/shared';
import SenderIdentitiesForm from './SenderIdentitiesForm';

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

function identity(over: Partial<SenderIdentityDto> = {}): SenderIdentityDto {
  return {
    id: 'i-1', stream: 'support', sendingDomainId: 'd-1', domain: 'mail.acme.test', localPart: 'help',
    displayName: 'Acme Help', replyTo: null, fromAddress: 'help@mail.acme.test',
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

const INBOUND = { configured: true, address: 'acme@tickets.example.com' };

function renderForm(over: Partial<React.ComponentProps<typeof SenderIdentitiesForm>> = {}) {
  return render(
    <SenderIdentitiesForm
      domains={[domain()]}
      identities={[]}
      inbound={INBOUND}
      busy={false}
      onSave={vi.fn()}
      onClear={vi.fn()}
      {...over}
    />,
  );
}

describe('SenderIdentitiesForm', () => {
  it('tells the partner to verify a domain first when none is sendable', () => {
    renderForm({ domains: [domain({ status: 'pending' })] });
    expect(screen.getByTestId('sending-domains-identities-empty').textContent)
      .toBe('Verify a domain first, then choose sender addresses.');
    expect(screen.queryByTestId('sending-identity-support')).toBeNull();
  });

  it('renders all three streams with their suggested local parts', () => {
    renderForm();
    for (const [stream, suggested] of [['support', 'support'], ['billing', 'billing'], ['general', 'notifications']] as const) {
      expect((screen.getByTestId(`sending-identity-${stream}-localpart`) as HTMLInputElement).value).toBe(suggested);
    }
  });

  it('seeds a configured stream from its saved identity', () => {
    renderForm({ identities: [identity()] });
    expect((screen.getByTestId('sending-identity-support-localpart') as HTMLInputElement).value).toBe('help');
    expect((screen.getByTestId('sending-identity-support-displayname') as HTMLInputElement).value).toBe('Acme Help');
  });

  it('shows the exact From address the stream will send with', () => {
    renderForm({ identities: [identity()] });
    expect(screen.getByTestId('sending-identity-support-from').textContent)
      .toBe('Sends from help@mail.acme.test');
  });

  it('states where replies go for each stream', () => {
    renderForm();
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('acme@tickets.example.com');
    expect(screen.getByTestId('sending-identity-billing-replies').textContent)
      .toContain('Reply-To to your billing email');
    expect(screen.getByTestId('sending-identity-general-replies').textContent)
      .toContain("Nothing here sets its own Reply-To");
  });

  it('warns on the support stream when this instance has no inbound address', () => {
    renderForm({ inbound: { configured: false, address: null } });
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('no inbound email address');
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('a mailbox someone reads');
  });

  it('saves a stream with the composed values, never a full From address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-billing-localpart'));
    await user.type(screen.getByTestId('sending-identity-billing-localpart'), 'Invoices');
    await user.type(screen.getByTestId('sending-identity-billing-displayname'), 'Acme Billing');
    await user.click(screen.getByTestId('sending-identity-billing-save'));

    expect(onSave).toHaveBeenCalledWith({
      stream: 'billing', sendingDomainId: 'd-1', localPart: 'invoices',
      displayName: 'Acme Billing', replyTo: null,
    });
  });

  it('refuses a reserved local part client-side', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-support-localpart'));
    await user.type(screen.getByTestId('sending-identity-support-localpart'), 'postmaster');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('postmaster, abuse and mailer-daemon are reserved.');
  });

  it('refuses a malformed local part client-side', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-support-localpart'));
    await user.type(screen.getByTestId('sending-identity-support-localpart'), '.nope.');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toContain('Use letters, numbers, dots');
  });

  it('refuses a display name that carries an address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.type(screen.getByTestId('sending-identity-support-displayname'), 'Acme billing@acme.test');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('A display name cannot contain an email address or a link.');
  });

  it('refuses an incomplete Reply-To address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.type(screen.getByTestId('sending-identity-support-replyto'), 'nope');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('Enter a complete email address.');
  });

  it('offers Clear only on a stream that is actually configured', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    renderForm({ identities: [identity()], onClear });

    expect(screen.queryByTestId('sending-identity-billing-clear')).toBeNull();
    await user.click(screen.getByTestId('sending-identity-support-clear'));
    expect(onClear).toHaveBeenCalledWith('support');
  });

  it('disables every control while the tab is busy', () => {
    renderForm({ busy: true });
    expect((screen.getByTestId('sending-identity-support-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-identity-support-localpart') as HTMLInputElement).disabled).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto } from '@breeze/shared';
import DomainStatusPanel from './DomainStatusPanel';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const CREATED = '2026-09-17T12:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: CREATED, statusChangedAt: CREATED,
    ...over,
  };
}

const RECORDS: SendingDomainDto['dnsRecords'] = [
  { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', status: 'pending' },
];

function renderPanel(d: SendingDomainDto, over: Partial<React.ComponentProps<typeof DomainStatusPanel>> = {}) {
  return render(
    <DomainStatusPanel
      domain={d}
      verifiesByDns
      busy={false}
      nowMs={CREATED_MS}
      onCheckNow={vi.fn()}
      onRemove={vi.fn()}
      {...over}
    />,
  );
}

describe('DomainStatusPanel — provisioning', () => {
  it('says it is preparing records and offers no Check now', () => {
    renderPanel(domain({ status: 'provisioning' }));
    expect(screen.getByTestId('sending-domain-d-1-provisioning').textContent).toBe('Preparing DNS records…');
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
  });

  it('stays quiet for the first two minutes', () => {
    renderPanel(domain({ status: 'provisioning' }), { nowMs: CREATED_MS + 119_000 });
    expect(screen.queryByTestId('sending-domain-d-1-provisioning-slow')).toBeNull();
  });

  it('shows the delay notice after two minutes', () => {
    renderPanel(domain({ status: 'provisioning' }), { nowMs: CREATED_MS + 121_000 });
    expect(screen.getByTestId('sending-domain-d-1-provisioning-slow').textContent)
      .toContain('taking longer than usual');
  });
});

describe('DomainStatusPanel — pending', () => {
  it('shows the records table and Check now', async () => {
    const onCheckNow = vi.fn();
    const user = userEvent.setup();
    renderPanel(domain({ status: 'pending', dnsRecords: RECORDS }), { onCheckNow });

    expect(screen.getByTestId('sending-domains-records')).not.toBeNull();
    expect(screen.getByTestId('sending-domains-records-note')).not.toBeNull();

    await user.click(screen.getByTestId('sending-domain-d-1-check'));
    expect(onCheckNow).toHaveBeenCalledWith('d-1');
  });
});

describe('DomainStatusPanel — static mode', () => {
  it('shows no records table, no Check now, and the verify-by-test hint', () => {
    renderPanel(domain({ provider: 'static', status: 'pending' }), { verifiesByDns: false });
    expect(screen.queryByTestId('sending-domains-records')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-static-hint').textContent)
      .toContain('accepts a test message');
  });

  it('tells the partner to ask the administrator when the operator has not listed the domain', () => {
    renderPanel(domain({ provider: 'static', status: 'failed', statusReason: 'provider_rejected' }), { verifiesByDns: false });
    expect(screen.getByTestId('sending-domain-d-1-failed').textContent)
      .toBe('Ask your Breeze administrator to allow this domain.');
  });
});

describe('DomainStatusPanel — verified and at risk', () => {
  it('renders the child test-send control for a verified domain and keeps Check now', () => {
    renderPanel(domain({ status: 'verified', dnsRecords: [{ ...RECORDS[0], status: 'verified' }] }), {
      children: <div data-testid="stub-test-send" />,
    });
    expect(screen.getByTestId('stub-test-send')).not.toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-check')).not.toBeNull();
    // The 72-hour wait note belongs to the wait, not to a verified domain.
    expect(screen.queryByTestId('sending-domains-records-note')).toBeNull();
  });

  it('names the missing record in the at-risk banner', () => {
    renderPanel(domain({
      status: 'at_risk',
      dnsRecords: [
        { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'x', status: 'verified' },
        { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1', status: 'failed' },
      ],
    }));
    const banner = screen.getByTestId('sending-domain-d-1-at-risk');
    expect(banner.textContent).toContain('TXT');
    expect(banner.textContent).toContain('send.mail.acme.test');
    expect(banner.textContent).toContain('Mail still goes out');
  });
});

describe('DomainStatusPanel — failed, suspended, removing', () => {
  it('explains a failure and offers both Try again and Remove', async () => {
    const onCheckNow = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const d = domain({ status: 'failed', statusReason: 'dns_not_detected' });
    renderPanel(d, { onCheckNow, onRemove });

    expect(screen.getByTestId('sending-domain-d-1-failed').textContent)
      .toBe('We could not find the DNS records within 72 hours.');

    await user.click(screen.getByTestId('sending-domain-d-1-retry'));
    expect(onCheckNow).toHaveBeenCalledWith('d-1');

    await user.click(screen.getByTestId('sending-domain-d-1-remove'));
    expect(onRemove).toHaveBeenCalledWith(d);
  });

  it('drops Try again once the 72-hour retry window has passed, keeping Remove', () => {
    // Past the window the worker is about to expire the row and a retry can no
    // longer keep the same DNS records, so offering it would be a lie.
    renderPanel(domain({ status: 'failed', statusReason: 'dns_not_detected' }), {
      nowMs: CREATED_MS + 73 * 60 * 60 * 1_000,
    });
    expect(screen.queryByTestId('sending-domain-d-1-retry')).toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-failed')).not.toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-remove')).not.toBeNull();
  });

  it('offers no action at all on a suspended domain', () => {
    renderPanel(domain({ status: 'suspended', statusReason: 'platform_suspended' }));
    expect(screen.getByTestId('sending-domain-d-1-suspended').textContent)
      .toBe('Breeze suspended this domain. Contact support.');
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-retry')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-remove')).toBeNull();
  });

  it('disables the row while it is being removed', () => {
    renderPanel(domain({ status: 'removing' }));
    expect(screen.getByTestId('sending-domain-row-d-1').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('sending-domain-d-1-status').textContent).toBe('Removing…');
    expect(screen.queryByTestId('sending-domain-d-1-remove')).toBeNull();
  });

  it('disables the actions while the tab is busy', () => {
    renderPanel(domain({ status: 'pending', dnsRecords: RECORDS }), { busy: true });
    expect((screen.getByTestId('sending-domain-d-1-check') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-domain-d-1-remove') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DomainStatusPanel — lastSendError', () => {
  it('shows the most recent delivery refusal whatever the status is', () => {
    renderPanel(domain({ status: 'verified', lastSendError: '550 5.7.60 sender not allowed' }));
    expect(screen.getByTestId('sending-domain-d-1-send-error').textContent)
      .toBe('Last delivery problem: 550 5.7.60 sender not allowed');
  });

  it('shows nothing when there has been no refusal', () => {
    renderPanel(domain({ status: 'verified' }));
    expect(screen.queryByTestId('sending-domain-d-1-send-error')).toBeNull();
  });
});

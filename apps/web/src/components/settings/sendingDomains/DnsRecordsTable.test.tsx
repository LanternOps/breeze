import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDnsRecordDto } from '@breeze/shared';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { showToast } from '../../shared/Toast';
import DnsRecordsTable from './DnsRecordsTable';

const showToastMock = vi.mocked(showToast);

const RECORDS: SendingDomainDnsRecordDto[] = [
  { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', ttl: 'Auto', status: 'verified' },
  { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1 include:example ~all', ttl: 'Auto', status: 'pending' },
  { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: 'send.mail.acme.test', value: 'feedback.example', priority: 10, ttl: 'Auto', status: 'failed' },
];

describe('DnsRecordsTable', () => {
  it('renders nothing when the provider publishes no records (static mode)', () => {
    const { container } = render(<DnsRecordsTable records={[]} showPendingNote />);
    expect(container.firstChild).toBeNull();
  });

  it('renders every column of spec §10 for every record', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    const table = screen.getByTestId('sending-domains-records');
    for (const header of ['Record type', 'Host label', 'Full name', 'Value', 'Priority', 'Status']) {
      expect(table.textContent).toContain(header);
    }
    const mx = screen.getByTestId('sending-domain-record-2');
    expect(mx.textContent).toContain('MX');
    expect(mx.textContent).toContain('send');
    expect(mx.textContent).toContain('send.mail.acme.test');
    expect(mx.textContent).toContain('feedback.example');
    expect(mx.textContent).toContain('10');
  });

  it('shows a per-record status', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    expect(screen.getByTestId('sending-domain-record-0-status').textContent).toBe('Verified');
    expect(screen.getByTestId('sending-domain-record-1-status').textContent).toBe('Pending');
    expect(screen.getByTestId('sending-domain-record-2-status').textContent).toBe('Failed');
  });

  it('copies a record value and says so', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own Clipboard stub on navigator.clipboard,
    // so the mock must be installed AFTER setup() runs (jsdom's own
    // navigator.clipboard getter is not configurable at module load time,
    // per the repo's MFASettings.copyCodes.test.tsx convention).
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);

    await user.click(screen.getByTestId('sending-domain-record-1-copy'));

    expect(writeText).toHaveBeenCalledWith('v=spf1 include:example ~all');
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Copied to the clipboard' }),
    );
  });

  it('carries the 72-hour note while the domain is still waiting', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    expect(screen.getByTestId('sending-domains-records-note').textContent).toContain('72 hours');
  });

  it('drops the 72-hour note once the domain is verified', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote={false} />);
    expect(screen.queryByTestId('sending-domains-records-note')).toBeNull();
  });
});

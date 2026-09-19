import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto } from '@breeze/shared';
import TestSendControl from './TestSendControl';

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

describe('TestSendControl', () => {
  it('explains what the test does and sends on click', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<TestSendControl domain={domain()} busy={false} onSend={onSend} />);

    expect(screen.getByTestId('sending-domain-d-1-test').textContent)
      .toContain('to your own sign-in address');

    await user.click(screen.getByTestId('sending-domain-d-1-test-submit'));
    expect(onSend).toHaveBeenCalledWith('d-1');
  });

  it('shows no result line before the first test', () => {
    render(<TestSendControl domain={domain()} busy={false} onSend={vi.fn()} />);
    expect(screen.queryByTestId('sending-domain-d-1-test-result')).toBeNull();
  });

  it('reports an in-flight test and disables the button', () => {
    render(<TestSendControl domain={domain({ lastTestStatus: 'pending' })} busy={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('sending-domain-d-1-test-result').textContent).toBe('Test email in progress…');
    expect((screen.getByTestId('sending-domain-d-1-test-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a sent test with its timestamp', () => {
    render(<TestSendControl
      domain={domain({ lastTestStatus: 'sent', lastTestAt: '2026-09-17T12:30:00.000Z' })}
      busy={false}
      onSend={vi.fn()}
    />);
    expect(screen.getByTestId('sending-domain-d-1-test-result').textContent).toContain('Last test sent');
  });

  it('reports a failed test with the relay error verbatim', () => {
    render(<TestSendControl
      domain={domain({ lastTestStatus: 'failed', lastTestAt: '2026-09-17T12:30:00.000Z', lastTestError: '553 sender rejected' })}
      busy={false}
      onSend={vi.fn()}
    />);
    const result = screen.getByTestId('sending-domain-d-1-test-result');
    expect(result.textContent).toContain('Last test failed');
    expect(result.textContent).toContain('553 sender rejected');
  });

  it('disables the button while the tab is busy', () => {
    render(<TestSendControl domain={domain()} busy onSend={vi.fn()} />);
    expect((screen.getByTestId('sending-domain-d-1-test-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

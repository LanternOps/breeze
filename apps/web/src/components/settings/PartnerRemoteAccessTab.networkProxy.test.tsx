import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PartnerRemoteAccessTab from './PartnerRemoteAccessTab';

// #8155 W03 (plan Task 13b): the partner-only opt-in for serving Network Proxy
// sessions from the dedicated tunnel origin. Page-level Save (settings rule 7).
const renderTab = (networkProxy: { dedicatedTunnelOrigin?: boolean }) => {
  const onNetworkProxyChange = vi.fn();
  render(
    <PartnerRemoteAccessTab
      data={{}}
      onChange={vi.fn()}
      networkProxy={networkProxy}
      onNetworkProxyChange={onNetworkProxyChange}
    />,
  );
  return { onNetworkProxyChange, toggle: screen.getByTestId('partner-network-proxy-dedicated-origin') };
};

describe('PartnerRemoteAccessTab — dedicated tunnel origin', () => {
  it('shows the switch on when the partner opted in, and turning it off reports false', () => {
    const { toggle, onNetworkProxyChange } = renderTab({ dedicatedTunnelOrigin: true });
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(onNetworkProxyChange).toHaveBeenCalledWith({ dedicatedTunnelOrigin: false });
  });

  it('shows the platform default (off) for a partner who never chose, and turning it on reports true', () => {
    const { toggle, onNetworkProxyChange } = renderTab({});
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onNetworkProxyChange).toHaveBeenCalledWith({ dedicatedTunnelOrigin: true });
  });

  it('says the setting is partner-wide, with no per-organization override', () => {
    renderTab({});
    expect(screen.getByText('Serve Network Proxy from a dedicated origin')).toBeInTheDocument();
    expect(screen.getByText(/Applies to all organizations/)).toBeInTheDocument();
  });
});

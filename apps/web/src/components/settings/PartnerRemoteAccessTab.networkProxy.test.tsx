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
  it('is a checkbox (saved by the header Save, not a switch), checked when the partner opted in; unticking reports false', () => {
    const { toggle, onNetworkProxyChange } = renderTab({ dedicatedTunnelOrigin: true });
    expect(toggle.tagName).toBe('INPUT');
    expect(toggle).toHaveAttribute('type', 'checkbox');
    expect(toggle).not.toHaveAttribute('role', 'switch');
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleName('Serve Network Proxy from a dedicated origin');
    fireEvent.click(toggle);
    expect(onNetworkProxyChange).toHaveBeenCalledWith({ dedicatedTunnelOrigin: false });
  });

  it('shows the platform default (unchecked) for a partner who never chose, and ticking it reports true', () => {
    const { toggle, onNetworkProxyChange } = renderTab({});
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onNetworkProxyChange).toHaveBeenCalledWith({ dedicatedTunnelOrigin: true });
  });

  it('says the setting is partner-wide, with no per-organization override', () => {
    renderTab({});
    expect(screen.getByText('Serve Network Proxy from a dedicated origin')).toBeInTheDocument();
    // The partner-wide model is stated by the badge, not restated in the help (#9790).
    expect(screen.getByTestId('partner-settings-badge-networkProxy.dedicatedTunnelOrigin')).toHaveTextContent('Partner-wide');
  });
});

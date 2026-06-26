import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import BreezeDefaultsPage from './BreezeDefaultsPage';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      features: [
        { featureType: 'remote_access', label: 'Remote Access', applied: true,
          inlineSettings: { webrtcDesktop: true, vncRelay: true, remoteTools: true }, behavior: 'Remote Desktop, VNC, and Remote Tools are ON by default; session limits apply.' },
        { featureType: 'patch', label: 'Patches', applied: false, inlineSettings: null, behavior: 'Not enforced — no patch deployments are created from policy.' },
      ],
    }),
  })),
}));

describe('BreezeDefaultsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the applied remote access default and its behavior', async () => {
    render(<BreezeDefaultsPage />);
    await waitFor(() => expect(screen.getByText('Remote Access')).toBeInTheDocument());
    expect(screen.getByText(/Remote Desktop, VNC, and Remote Tools are ON/)).toBeInTheDocument();
  });

  it('renders a not-enforced feature and a create-override link', async () => {
    render(<BreezeDefaultsPage />);
    await waitFor(() => expect(screen.getByText('Patches')).toBeInTheDocument());
    // Two matches expected: the "Not enforced" badge AND the behavior paragraph
    // ("Not enforced — ..."). >= 2 guards against the applied-branch badge silently
    // disappearing while the behavior text still renders.
    expect(screen.getAllByText(/Not enforced/).length).toBeGreaterThanOrEqual(2);
    const links = screen.getAllByRole('link', { name: /create override/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/configuration-policies/new'));
  });
});

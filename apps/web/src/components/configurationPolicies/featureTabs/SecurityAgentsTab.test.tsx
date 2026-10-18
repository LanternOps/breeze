import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
  hook: {
    error: undefined as string | undefined,
    errorDetail: undefined as { status: number; code?: string; body?: unknown } | undefined,
  },
}));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: m.hook.error,
    errorDetail: m.hook.errorDetail,
    clearError: vi.fn(),
  }),
}));

import SecurityAgentsTab from './SecurityAgentsTab';
import type { FeatureLink } from './types';

const props = {
  policyId: 'policy',
  existingLink: undefined as FeatureLink | undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
  orgId: 'org-1' as string | null,
};

const saveButton = () => screen.getByRole('button', { name: /^save$/i });

beforeEach(() => {
  vi.clearAllMocks();
  m.hook.error = undefined;
  m.hook.errorDetail = undefined;
  m.save.mockResolvedValue({
    id: 'link',
    featureType: 'security_agents',
    featurePolicyId: null,
    inlineSettings: { version: 1, agents: [] },
  });
});

describe('SecurityAgentsTab', () => {
  it('saves the exact payload when Huntress is toggled on', async () => {
    render(<SecurityAgentsTab {...props} />);
    const toggle = screen.getByTestId('security-agents-huntress-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(m.save).toHaveBeenCalledWith(null, {
        featureType: 'security_agents',
        featurePolicyId: null,
        inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true }] },
      }),
    );
    expect(m.changed).toHaveBeenCalledWith(expect.objectContaining({ id: 'link' }), 'security_agents');
  });

  it('saves an empty agents list (opt out) when nothing is enabled', async () => {
    render(<SecurityAgentsTab {...props} />);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(m.save).toHaveBeenCalledWith(null, {
        featureType: 'security_agents',
        featurePolicyId: null,
        inlineSettings: { version: 1, agents: [] },
      }),
    );
  });

  it.each(['sentinelone', 'controld', 'nextdns'])('does not allow %s to be enabled', async (vendor) => {
    render(<SecurityAgentsTab {...props} />);
    const toggle = screen.getByTestId(`security-agents-${vendor}-toggle`) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    const payload = m.save.mock.calls[0][1] as { inlineSettings: { agents: Array<{ vendor: string; enabled: boolean }> } };
    expect(payload.inlineSettings.agents.some((a) => a.vendor === vendor && a.enabled)).toBe(false);
    expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(3);
  });

  it('preserves stored platforms and PATCHes the existing link on re-save', async () => {
    render(
      <SecurityAgentsTab
        {...props}
        existingLink={{
          id: 'link-9',
          featureType: 'security_agents',
          featurePolicyId: null,
          inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, platforms: ['windows'] }] },
        }}
      />,
    );
    expect((screen.getByTestId('security-agents-huntress-toggle') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(m.save).toHaveBeenCalledWith('link-9', {
        featureType: 'security_agents',
        featurePolicyId: null,
        inlineSettings: {
          version: 1,
          agents: [{ vendor: 'huntress', enabled: true, platforms: ['windows'] }],
        },
      }),
    );
  });

  it('keeps a stored disabled entry (and its platforms) disabled on re-save', async () => {
    render(
      <SecurityAgentsTab
        {...props}
        existingLink={{
          id: 'link-9',
          featureType: 'security_agents',
          featurePolicyId: null,
          inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: false, platforms: ['windows'] }] },
        }}
      />,
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(m.save.mock.calls[0][1]).toEqual({
      featureType: 'security_agents',
      featurePolicyId: null,
      inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: false, platforms: ['windows'] }] },
    });
  });

  it('renders the platform notes, the install notice and the closer-link warning', () => {
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByText(/requires MDM approval/i)).toBeInTheDocument();
    expect(screen.getByTestId('security-agents-platform-windows')).toBeInTheDocument();
    expect(screen.getByTestId('security-agents-platform-linux')).toBeInTheDocument();
    expect(screen.getByTestId('security-agents-keys-notice')).toHaveTextContent(/never uninstalls/i);
    expect(screen.getByTestId('security-agents-closer-warning')).toHaveTextContent(/replaces these settings entirely/i);
  });

  it('shows the all-organizations badge only for partner-wide policies', () => {
    const { rerender } = render(<SecurityAgentsTab {...props} orgId={null} />);
    expect(screen.getByTestId('security-agents-partner-wide-badge')).toHaveTextContent(/all organizations/i);
    rerender(<SecurityAgentsTab {...props} orgId="org-1" />);
    expect(screen.queryByTestId('security-agents-partner-wide-badge')).not.toBeInTheDocument();
    rerender(<SecurityAgentsTab {...props} orgId={undefined} />);
    expect(screen.queryByTestId('security-agents-partner-wide-badge')).not.toBeInTheDocument();
  });

  it('renders a deep link to the setup path when the catalog is missing', () => {
    m.hook.error = 'The Huntress catalog package is missing';
    m.hook.errorDetail = {
      status: 400,
      code: 'security_agents_catalog_missing',
      body: { code: 'security_agents_catalog_missing', vendors: ['huntress'], setupPath: '/integrations#huntress' },
    };
    render(<SecurityAgentsTab {...props} />);
    const link = screen.getByTestId('security-agents-catalog-missing-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/integrations#huntress');
  });

  it('refuses to render an off-site setupPath as a link', () => {
    m.hook.errorDetail = {
      status: 400,
      code: 'security_agents_catalog_missing',
      body: { setupPath: 'https://evil.example/x' },
    };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-catalog-missing-link')).toHaveAttribute('href', '/integrations#huntress');
  });

  it.each(['//evil.example/x', '/\\evil.example/x', '/ok\\..\\x'])('refuses a protocol-relative setupPath %s', (setupPath) => {
    m.hook.errorDetail = { status: 400, code: 'security_agents_catalog_missing', body: { setupPath } };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-catalog-missing-link')).toHaveAttribute('href', '/integrations#huntress');
  });

  it('explains the missing execute permission on 403 security_agents_execute_required', () => {
    m.hook.error = 'Forbidden';
    m.hook.errorDetail = { status: 403, code: 'security_agents_execute_required', body: {} };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-execute-required')).toBeInTheDocument();
  });
});

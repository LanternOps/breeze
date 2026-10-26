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

  it('saves the exact payload when SentinelOne is toggled on (W04)', async () => {
    render(<SecurityAgentsTab {...props} />);
    const toggle = screen.getByTestId('security-agents-sentinelone-toggle') as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(m.save).toHaveBeenCalledWith(null, {
        featureType: 'security_agents',
        featurePolicyId: null,
        inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] },
      }),
    );
  });

  it('shows a stored enabled SentinelOne entry as on (not hardcoded off)', () => {
    render(
      <SecurityAgentsTab
        {...props}
        existingLink={{
          id: 'link-9',
          featureType: 'security_agents',
          featurePolicyId: null,
          inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] },
        }}
      />,
    );
    expect((screen.getByTestId('security-agents-sentinelone-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('SentinelOne notes: Windows only, and the MSI must be uploaded first', () => {
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-sentinelone-platform-windows')).toBeInTheDocument();
    expect(screen.getByTestId('security-agents-sentinelone-platform-macos')).toHaveTextContent(/not supported/i);
    expect(screen.getByTestId('security-agents-sentinelone-platform-linux')).toHaveTextContent(/not supported/i);
    expect(screen.getByTestId('security-agents-sentinelone-msi-note')).toHaveTextContent(/SentinelOne MSI.*Versions tab.*SITE_TOKEN=\{s1_site_token\}/i);
  });

  it('renders the binary-missing banner with a deep link to the package Versions tab', () => {
    m.hook.error = 'SentinelOne cannot be enabled until its installer is uploaded';
    m.hook.errorDetail = {
      status: 400,
      code: 'security_agents_binary_missing',
      body: { code: 'security_agents_binary_missing', vendors: ['sentinelone'], setupPath: '/software#versions=cat-s1' },
    };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-binary-missing')).toHaveTextContent(/SentinelOne/);
    expect(screen.getByTestId('security-agents-binary-missing')).toHaveTextContent(/Versions tab/i);
    const link = screen.getByTestId('security-agents-binary-missing-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/software#versions=cat-s1');
    // Handled inline: the generic error banner is not shown as well.
    expect(screen.queryByText('SentinelOne cannot be enabled until its installer is uploaded')).not.toBeInTheDocument();
  });

  it('the binary-missing deep link goes through the same off-site guard', () => {
    m.hook.errorDetail = { status: 400, code: 'security_agents_binary_missing', body: { setupPath: '//evil.example/x' } };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-binary-missing-link')).toHaveAttribute('href', '/software');
  });

  it('the catalog-missing banner names the vendor the API refused (SentinelOne, not Huntress)', () => {
    m.hook.errorDetail = {
      status: 400,
      code: 'security_agents_catalog_missing',
      body: { vendors: ['sentinelone'], setupPath: '/integrations#sentinelone' },
    };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-catalog-missing')).toHaveTextContent(/SentinelOne/);
    expect(screen.getByTestId('security-agents-catalog-missing')).not.toHaveTextContent(/Huntress/);
    expect(screen.getByTestId('security-agents-catalog-missing-link')).toHaveAttribute('href', '/integrations#sentinelone');
  });

  it.each(['controld', 'nextdns'])('does not allow %s to be enabled', async (vendor) => {
    render(<SecurityAgentsTab {...props} />);
    const toggle = screen.getByTestId(`security-agents-${vendor}-toggle`) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    const payload = m.save.mock.calls[0][1] as { inlineSettings: { agents: Array<{ vendor: string; enabled: boolean }> } };
    expect(payload.inlineSettings.agents.some((a) => a.vendor === vendor && a.enabled)).toBe(false);
    expect(screen.getAllByText(/coming soon/i)).toHaveLength(2);
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

// #6960 W05: the DNS vendors are wired but stay off until the #6958 lab gates
// are recorded (code-only wave); their notes and the catalog-missing copy ship now.
describe('SecurityAgentsTab — DNS-filtering vendors (#6960 W05)', () => {
  it.each([
    ['controld', 'Control D', 'controld_provisioning_code'],
    ['nextdns', 'NextDNS', 'nextdns_profile_id'],
  ])('%s (%s) notes: Windows only, add it from Built-in packages, set %s per organization (non-secret), coverage is readiness only', (vendor, name, variable) => {
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId(`security-agents-${vendor}-platform-windows`)).toHaveTextContent(/Windows/);
    expect(screen.getByTestId(`security-agents-${vendor}-platform-macos`)).toHaveTextContent(/not supported/i);
    expect(screen.getByTestId(`security-agents-${vendor}-platform-linux`)).toHaveTextContent(/not supported/i);
    expect(screen.getByTestId(`security-agents-${vendor}-builtin-note`)).toHaveTextContent(new RegExp(`${name}.*Built-in packages`));
    expect(screen.getByTestId(`security-agents-${vendor}-builtin-link`)).toHaveAttribute('href', '/software');
    const variableNote = screen.getByTestId(`security-agents-${vendor}-variable-note`);
    expect(variableNote).toHaveTextContent(variable);
    expect(variableNote).toHaveTextContent(/not secret/i);
    expect(screen.getByTestId(`security-agents-${vendor}-variable-link`)).toHaveAttribute('href', '/settings/variables');
    expect(screen.getByTestId(`security-agents-${vendor}-coverage-note`)).toHaveTextContent(name);
  });

  it('the catalog-missing banner for a DNS vendor points at Built-in packages, not an integration', () => {
    m.hook.errorDetail = { status: 400, code: 'security_agents_catalog_missing', body: { vendors: ['nextdns'] } };
    render(<SecurityAgentsTab {...props} />);
    const banner = screen.getByTestId('security-agents-catalog-missing');
    expect(banner).toHaveTextContent(/NextDNS/);
    expect(banner).toHaveTextContent(/Built-in packages/);
    expect(banner).not.toHaveTextContent(/integration/i);
    expect(screen.getByTestId('security-agents-catalog-missing-link')).toHaveAttribute('href', '/software');
  });

  it('the DNS catalog-missing link still goes through the off-site guard', () => {
    m.hook.errorDetail = { status: 400, code: 'security_agents_catalog_missing', body: { vendors: ['controld'], setupPath: '//evil.example' } };
    render(<SecurityAgentsTab {...props} />);
    expect(screen.getByTestId('security-agents-catalog-missing-link')).toHaveAttribute('href', '/software');
  });

  it('a stored enabled DNS entry is not shown on, and re-saving keeps it off, while the vendor is not enableable', async () => {
    render(
      <SecurityAgentsTab
        {...props}
        existingLink={{
          id: 'link',
          featureType: 'security_agents',
          featurePolicyId: null,
          inlineSettings: { version: 1, agents: [{ vendor: 'nextdns', enabled: true, platforms: ['windows'] }] },
        } as FeatureLink}
      />,
    );
    expect((screen.getByTestId('security-agents-nextdns-toggle') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    expect(m.save.mock.calls[0][1].inlineSettings.agents).toEqual([{ vendor: 'nextdns', enabled: false, platforms: ['windows'] }]);
  });

  it('renders translated DNS notes in a non-English locale (no raw keys)', async () => {
    const { i18n, loadLocale } = await import('@/lib/i18n');
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');
    try {
      render(<SecurityAgentsTab {...props} />);
      for (const id of ['nextdns-builtin-note', 'nextdns-variable-note', 'nextdns-coverage-note']) {
        const text = screen.getByTestId(`security-agents-${id}`).textContent ?? '';
        expect(text, id).not.toMatch(/securityAgentsTab\.|dnsVariableNote|dnsBuiltinNote|dnsCoverageNote/);
      }
      expect(screen.getByTestId('security-agents-nextdns-variable-note')).toHaveTextContent('nextdns_profile_id');
      // Proves the German bundle rendered (not a silent English fallback).
      expect(screen.getByTestId('security-agents-nextdns-variable-note')).toHaveTextContent(/Mandantenvariable/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

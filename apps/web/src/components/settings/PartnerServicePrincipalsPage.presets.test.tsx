import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS,
  partnerServicePrincipalScopeI18nKey,
} from '@breeze/shared';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), currentUserId: 'owner' }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: mocks.currentUserId } }),
}));
vi.mock('../../lib/runAction', () => ({ runAction: vi.fn(), handleActionError: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { owner?: string }) => (options?.owner ? `${key}[${options.owner}]` : key),
  }),
}));

import PartnerServicePrincipalsPage from './PartnerServicePrincipalsPage';
import enSettings from '../../locales/en/settings.json';

function listResponse(data: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

function checkedScopes(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid^="scope-checkbox-"]:checked'))
    .map((input) => input.dataset.testid!.replace('scope-checkbox-', ''))
    .sort();
}

async function openCreate() {
  render(<PartnerServicePrincipalsPage />);
  fireEvent.click(await screen.findByTestId('create-principal'));
}

describe('PartnerServicePrincipalsPage scope presets (#8173)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWithAuth.mockResolvedValue(listResponse([]));
  });

  it('offers one button per shared preset in the create dialog', async () => {
    await openCreate();
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      expect(screen.getByTestId(`scope-preset-${preset.id}`)).toBeInTheDocument();
    }
  });

  it('fills the checkboxes from the chosen preset and leaves them editable', async () => {
    await openCreate();
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      fireEvent.click(screen.getByTestId(`scope-preset-${preset.id}`));
      expect(checkedScopes(), preset.id).toEqual([...preset.scopes].sort());
    }
    fireEvent.click(screen.getByTestId('scope-preset-alert-feed'));
    fireEvent.click(screen.getByTestId('scope-checkbox-tickets:read'));
    expect(checkedScopes()).toEqual(['alerts:read', 'organizations:read', 'tickets:read']);
  });

  it('never pre-selects ai:execute_admin from any preset', async () => {
    await openCreate();
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      fireEvent.click(screen.getByTestId(`scope-preset-${preset.id}`));
      expect(screen.getByTestId('scope-checkbox-ai:execute_admin')).not.toBeChecked();
    }
  });

  it('keeps the enrollment-keys:write expiry + CIDR gate after the provisioning preset', async () => {
    await openCreate();
    fireEvent.click(screen.getByTestId('scope-preset-provisioning'));
    expect(screen.getByTestId('write-scope-restrictions-required')).toBeInTheDocument();
    expect(screen.getByTestId('save-principal')).toBeDisabled();
  });

  it('re-enables Save once the provisioning preset has an expiry and source CIDR', async () => {
    await openCreate();
    fireEvent.click(screen.getByTestId('scope-preset-provisioning'));
    fireEvent.change(screen.getByText('partnerServicePrincipals.sourceCidrs').querySelector('textarea')!, {
      target: { value: '203.0.113.0/24' },
    });
    fireEvent.change(screen.getByText('partnerServicePrincipals.expiresAt').querySelector('input')!, {
      target: { value: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16) },
    });
    expect(screen.queryByTestId('write-scope-restrictions-required')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-principal')).not.toBeDisabled();
  });

  it('replaces (not merges with) a hand-ticked selection when a preset is chosen', async () => {
    await openCreate();
    fireEvent.click(screen.getByTestId('scope-checkbox-ai:execute_admin'));
    expect(screen.getByTestId('scope-checkbox-ai:execute_admin')).toBeChecked();
    fireEvent.click(screen.getByTestId('scope-preset-alert-feed'));
    expect(screen.getByTestId('scope-checkbox-ai:execute_admin')).not.toBeChecked();
    expect(checkedScopes()).toEqual(['alerts:read', 'organizations:read']);
  });

  it('shows a description next to every scope', async () => {
    await openCreate();
    for (const scope of PARTNER_SERVICE_PRINCIPAL_SCOPES) {
      expect(screen.getByTestId(`scope-description-${scope}`)).toHaveTextContent(
        `partnerServicePrincipals.scopeDescriptions.${partnerServicePrincipalScopeI18nKey(scope)}`,
      );
    }
  });

  it('does not offer presets when editing an existing principal', async () => {
    mocks.fetchWithAuth.mockResolvedValue(listResponse([{
      id: 'p1', name: 'Existing', description: null, status: 'active', scopes: ['devices:read'],
      expiresAt: null, sourceCidrs: [], owner: { id: 'owner', name: 'Pat' }, keys: [],
    }]));
    render(<PartnerServicePrincipalsPage />);
    await screen.findByText('Existing');
    fireEvent.click(screen.getByText('partnerServicePrincipals.edit'));
    expect(screen.queryByTestId('scope-preset-docs-sync')).not.toBeInTheDocument();
    expect(screen.getByTestId('scope-description-devices:read')).toBeInTheDocument();
  });
});

describe('scope preset + description copy', () => {
  const sp = enSettings.partnerServicePrincipals as Record<string, unknown>;
  const descriptions = sp.scopeDescriptions as Record<string, string> | undefined;
  const presets = sp.presets as Record<string, { label: string; description: string }> | undefined;

  it('has an English description for every scope in the shared registry', () => {
    for (const scope of PARTNER_SERVICE_PRINCIPAL_SCOPES) {
      const text = descriptions?.[partnerServicePrincipalScopeI18nKey(scope)];
      expect(text, scope).toBeTruthy();
    }
  });

  it('has an English label + description for every preset, with no third-party product names', () => {
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      const copy = presets?.[preset.id];
      expect(copy?.label, preset.id).toBeTruthy();
      expect(copy?.description, preset.id).toBeTruthy();
    }
    expect(JSON.stringify([presets, descriptions])).not.toMatch(/weavestream/i);
  });
});

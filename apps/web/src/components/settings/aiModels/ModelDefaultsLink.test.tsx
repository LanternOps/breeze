import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import ModelDefaultsLink from './ModelDefaultsLink';

const ORG = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';

beforeEach(() => fetchWithAuth.mockReset());

describe('ModelDefaultsLink', () => {
  it('without an org shows static text and only the partner link, with no fetch', () => {
    render(<ModelDefaultsLink surface="script_reviewer" level="partner" />);
    const box = screen.getByTestId('model-defaults-link-script_reviewer');
    expect(box.textContent).toMatch(/Model: Set per feature/);
    expect(screen.getByTestId('model-defaults-link-partner').getAttribute('href')).toBe('/settings/partner#ai-provider');
    expect(screen.queryByTestId('model-defaults-link-org')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('with an org shows the effective model and links to the org override', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({
      orgId: ORG,
      offerings: [{ id: OFF, displayName: 'Claude Sonnet' }],
      surfaces: [{ surface: 'office_chat', effective: { defaultOfferingId: OFF, defaultSource: 'partner' } }],
    }));
    render(<ModelDefaultsLink surface="office_chat" orgId={ORG} level="org" />);
    await waitFor(() => expect(screen.getByTestId('model-defaults-link-office_chat').textContent).toMatch(/Model: Claude Sonnet/));
    expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/orgs/${ORG}/assignments`);
    expect(screen.getByTestId('model-defaults-link-org').getAttribute('href')).toBe(`/settings/organizations/${ORG}#ai`);
  });

  it('says no default is set when the surface has none', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({
      orgId: ORG, offerings: [],
      surfaces: [{ surface: 'office_chat', effective: { defaultOfferingId: null, defaultSource: 'none' } }],
    }));
    render(<ModelDefaultsLink surface="office_chat" orgId={ORG} level="org" />);
    await waitFor(() => expect(screen.getByTestId('model-defaults-link-office_chat').textContent).toMatch(/no default set/));
  });

  it('keeps the static text and links when the lookup fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'no' }, 403));
    render(<ModelDefaultsLink surface="office_chat" orgId={ORG} level="org" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.getByTestId('model-defaults-link-office_chat').textContent).toMatch(/Set per feature/);
    expect(screen.getByTestId('model-defaults-link-org')).toBeTruthy();
  });
});

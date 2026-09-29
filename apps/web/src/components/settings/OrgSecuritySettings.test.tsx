import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';

import OrgSecuritySettings from './OrgSecuritySettings';
import { fetchWithAuth } from '../../stores/auth';

// The header switcher sits on a DIFFERENT org than the one the settings page
// is editing (`/settings/organizations/<orgId>#security`): nothing here may
// read it.
const { SWITCHER_ORG, PAGE_ORG } = vi.hoisted(() => ({
  SWITCHER_ORG: 'org-switcher',
  PAGE_ORG: 'org-page',
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({ currentOrgId: SWITCHER_ORG }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

describe('OrgSecuritySettings: mTLS policy org scoping', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as Response);
  });

  // Pre-release sweep (v0.118.2 → main): the mTLS form shows the PAGE org's
  // policy (handed in via `mtls`) but saved it to the switcher's org.
  it('saves the mTLS policy to the org it is given, never the header switcher org', async () => {
    render(
      <OrgSecuritySettings
        orgId={PAGE_ORG}
        mtls={{ certLifetimeDays: 30, expiredCertPolicy: 'quarantine' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save mtls/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/agents/org/${PAGE_ORG}/settings/mtls`);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ certLifetimeDays: 30, expiredCertPolicy: 'quarantine' });
    expect(String(url)).not.toContain(SWITCHER_ORG);
  });

  // The page re-posts the whole settings blob on its section saves, so it must
  // hear about this own-route write or its next save reverts it.
  it('reports a successful mTLS save to the page, and a failed one not at all', async () => {
    const onMtlsSaved = vi.fn();
    const { unmount } = render(<OrgSecuritySettings orgId={PAGE_ORG} onMtlsSaved={onMtlsSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /save mtls/i }));
    await waitFor(() => expect(onMtlsSaved).toHaveBeenCalledTimes(1));
    unmount();

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'nope' }),
    } as unknown as Response);
    const onFailedSave = vi.fn();
    render(<OrgSecuritySettings orgId={PAGE_ORG} onMtlsSaved={onFailedSave} />);
    fireEvent.click(screen.getByRole('button', { name: /save mtls/i }));
    await screen.findByText('nope');
    expect(onFailedSave).not.toHaveBeenCalled();
  });
});

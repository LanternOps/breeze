import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContactResponsibilitiesCard from './ContactResponsibilitiesCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('ContactResponsibilitiesCard', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('requests the site-scoped resolution and renders responsible contacts with their scope', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({
      responsibilities: [
        {
          role: 'technical',
          level: 'site',
          contacts: [
            { contactId: 'c1', name: 'Maria Silva', email: 'maria@example.com', phone: null, mobile: null, title: 'Servers', isPrimary: true },
          ],
        },
      ],
    }));

    render(<ContactResponsibilitiesCard orgId={ORG_ID} siteId={SITE_ID} />);

    expect(await screen.findByText('Maria Silva')).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/contact-responsibilities?siteId=${SITE_ID}`,
    );
    expect(screen.getByText('This site')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
  });

  it('uses the deviceId query when rendered for a device', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ responsibilities: [] }));

    render(<ContactResponsibilitiesCard orgId={ORG_ID} siteId={SITE_ID} deviceId="33333333-3333-4333-8333-333333333333" />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/contact-responsibilities?deviceId=33333333-3333-4333-8333-333333333333`,
    );
  });

  it('shows the empty state when nothing resolves', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ responsibilities: [] }));

    render(<ContactResponsibilitiesCard orgId={ORG_ID} siteId={SITE_ID} />);

    expect(await screen.findByText('No responsible contacts are assigned yet.')).toBeTruthy();
  });

  it('shows the failure state when the request fails', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ error: 'nope' }, 404));

    render(<ContactResponsibilitiesCard orgId={ORG_ID} siteId={SITE_ID} />);

    expect(await screen.findByText('Could not load responsible contacts.')).toBeTruthy();
  });
});

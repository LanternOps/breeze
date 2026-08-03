import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PossibleReplacementBanner from './PossibleReplacementBanner';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// runAction surfaces outcome through showToast; mock it so the assertions can
// prove feedback reached the user without rendering a real toast.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const OLD_DEVICE_ID = '11111111-1111-1111-1111-111111111111';

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function oldDevicePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: OLD_DEVICE_ID,
    hostname: 'OLD-LAPTOP-01',
    displayName: null,
    status: 'offline',
    ...overrides,
  };
}

describe('PossibleReplacementBanner (#2764)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when possibleReplacementOfDeviceId is null', () => {
    const { container } = render(
      <PossibleReplacementBanner possibleReplacementOfDeviceId={null} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing when possibleReplacementOfDeviceId is absent', () => {
    const { container } = render(<PossibleReplacementBanner />);

    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders the review banner with the old hostname and a link to the old device', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(oldDevicePayload()));

    render(<PossibleReplacementBanner possibleReplacementOfDeviceId={OLD_DEVICE_ID} />);

    expect(await screen.findByTestId('possible-replacement-banner')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('possible-replacement-message').textContent).toContain(
        'OLD-LAPTOP-01',
      ),
    );
    expect(screen.getByTestId('possible-replacement-message').textContent).toMatch(
      /may replace/i,
    );
    expect(screen.getByTestId('possible-replacement-link')).toHaveAttribute(
      'href',
      `/devices/${OLD_DEVICE_ID}`,
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${OLD_DEVICE_ID}`);
  });

  it('decommissions the old device through runAction and re-fetches it afterwards', async () => {
    fetchWithAuthMock
      // initial summary fetch
      .mockResolvedValueOnce(jsonResponse(oldDevicePayload()))
      // DELETE
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      // re-fetch after success
      .mockResolvedValueOnce(jsonResponse(oldDevicePayload({ status: 'decommissioned' })));

    render(<PossibleReplacementBanner possibleReplacementOfDeviceId={OLD_DEVICE_ID} />);

    const button = await screen.findByTestId('possible-replacement-decommission');
    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(`/devices/${OLD_DEVICE_ID}`, {
        method: 'DELETE',
      }),
    );

    // runAction reported success to the user (no silent mutation).
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' }),
      ),
    );

    // Re-fetched: initial + DELETE + re-fetch.
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));

    // The re-fetch shows the old row as already decommissioned, so the action
    // retires and the resolved note takes its place.
    await waitFor(() =>
      expect(screen.queryByTestId('possible-replacement-decommission')).toBeNull(),
    );
    expect(screen.getByTestId('possible-replacement-resolved')).toBeInTheDocument();
  });

  it('toasts and keeps the action available when the decommission fails', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse(oldDevicePayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500));

    render(<PossibleReplacementBanner possibleReplacementOfDeviceId={OLD_DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('possible-replacement-decommission'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(screen.getByTestId('possible-replacement-decommission')).toBeEnabled();
  });

  it('does not toast twice on a 401 (auth redirect owns the feedback)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse(oldDevicePayload()))
      .mockResolvedValueOnce(jsonResponse(null, false, 401));

    render(<PossibleReplacementBanner possibleReplacementOfDeviceId={OLD_DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('possible-replacement-decommission'));

    await waitFor(() =>
      expect(screen.getByTestId('possible-replacement-decommission')).toBeEnabled(),
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('still renders (with a generic label and no action) when the old device 404s', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'not found' }, false, 404));

    render(<PossibleReplacementBanner possibleReplacementOfDeviceId={OLD_DEVICE_ID} />);

    expect(await screen.findByTestId('possible-replacement-banner')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('possible-replacement-unavailable')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('possible-replacement-decommission')).toBeNull();
  });
});

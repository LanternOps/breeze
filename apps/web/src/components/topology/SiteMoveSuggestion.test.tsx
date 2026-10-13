import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import SiteMoveSuggestion, { type SiteMoveSuggestionProps } from './SiteMoveSuggestion';
import { LAKESIDE, MAIN_OFFICE, presenceDeviceId } from './presenceFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); vi.mocked(showToast).mockReset(); });
afterEach(cleanup);

/** Site location W3 (#7887, spec S§10.3, S§11). Fictional names only. */
const DEVICE = presenceDeviceId(1);
const SUGGESTION = { siteId: LAKESIDE.id, siteName: LAKESIDE.name, days: 9, firstObservedAt: '2026-09-14T08:00:00.000Z', lastObservedAt: '2026-10-02T18:00:00.000Z' };
const props = (over: Partial<SiteMoveSuggestionProps> = {}): SiteMoveSuggestionProps => ({
  deviceId: DEVICE, deviceName: 'DESKTOP-HD7K2QF', assignedSite: MAIN_OFFICE, prefix: '10.1.5.0/24', suggestion: SUGGESTION,
  confirmedAt: null, canMove: true, onChanged: vi.fn(), ...over,
});
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

describe('SiteMoveSuggestion', () => {
  it('shows the suggestion copy with day count and date range, and never "always"/"away"', () => {
    const { container } = render(<SiteMoveSuggestion {...props()} />);
    expect(screen.getByText('Probably assigned to the wrong site.')).toBeInTheDocument();
    const evidence = screen.getByTestId('topology-suggestion-evidence').textContent!;
    expect(evidence).toContain("Lakeside's network (10.1.5.0/24)");
    expect(evidence).toContain('9 days');
    expect(evidence).toMatch(/14 Sep|Sep 14/);
    expect(evidence).toMatch(/2 Oct|Oct 2/);
    expect(evidence).toContain('No Main Office-network observations');
    expect(container.textContent!.toLowerCase()).not.toMatch(/\balways\b|\baway\b/);
  });

  it('"Move to Lakeside" confirms with the policy implication, then PATCHes siteId + expectedSiteId + siteMoveTrigger via runAction and refetches', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ id: DEVICE }));
    const onChanged = vi.fn();
    render(<SiteMoveSuggestion {...props({ onChanged })} />);
    fireEvent.click(screen.getByTestId('topology-suggestion-move'));
    expect(fetchWithAuth).not.toHaveBeenCalled(); // confirmation first
    expect(screen.getByTestId('topology-suggestion-confirm').textContent).toContain("Moving changes which site's configuration policies, maintenance windows, alert routing and reports apply to DESKTOP-HD7K2QF. Breeze will not move it back automatically.");
    fireEvent.click(screen.getByTestId('topology-suggestion-confirm-move'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toBe(`/devices/${DEVICE}`);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init!.body as string)).toEqual({ siteId: LAKESIDE.id, expectedSiteId: MAIN_OFFICE.id, siteMoveTrigger: 'topology_suggestion' });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('cancel leaves the device where it is', () => {
    render(<SiteMoveSuggestion {...props()} />);
    fireEvent.click(screen.getByTestId('topology-suggestion-move'));
    fireEvent.click(screen.getByTestId('topology-suggestion-cancel'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('topology-suggestion-move')).toBeInTheDocument();
  });

  it('"Move to Lakeside" is hidden without devices:write; "Keep at Main Office" PUTs the confirmation', async () => {
    const { unmount } = render(<SiteMoveSuggestion {...props({ canMove: false })} />);
    expect(screen.getByText('Probably assigned to the wrong site.')).toBeInTheDocument();
    expect(screen.queryByTestId('topology-suggestion-move')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topology-suggestion-keep')).not.toBeInTheDocument();
    unmount();

    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ confirmedAt: '2026-10-02T09:30:00.000Z' }));
    const onChanged = vi.fn();
    render(<SiteMoveSuggestion {...props({ onChanged })} />);
    expect(screen.getByTestId('topology-suggestion-keep').textContent).toBe('Keep at Main Office');
    fireEvent.click(screen.getByTestId('topology-suggestion-keep'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toBe(`/devices/${DEVICE}/site-assignment-confirmation`);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBeUndefined();
  });

  it('confirmed device shows "Suggestions off" with a "Turn on" action that DELETEs the confirmation', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ confirmedAt: null }));
    const onChanged = vi.fn();
    render(<SiteMoveSuggestion {...props({ suggestion: null, confirmedAt: '2026-10-02T09:30:00.000Z', onChanged })} />);
    expect(screen.getByTestId('topology-suggestion-off').textContent).toMatch(/Site assignment confirmed on (2 Oct|Oct 2) · Suggestions off/);
    fireEvent.click(screen.getByTestId('topology-suggestion-turn-on'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toBe(`/devices/${DEVICE}/site-assignment-confirmation`);
    expect(init?.method).toBe('DELETE');
  });

  it('"Turn on" is hidden without devices:write; nothing renders without a suggestion or confirmation', () => {
    const { unmount } = render(<SiteMoveSuggestion {...props({ suggestion: null, confirmedAt: '2026-10-02T09:30:00.000Z', canMove: false })} />);
    expect(screen.getByTestId('topology-suggestion-off')).toBeInTheDocument();
    expect(screen.queryByTestId('topology-suggestion-turn-on')).not.toBeInTheDocument();
    unmount();
    const { container } = render(<SiteMoveSuggestion {...props({ suggestion: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('409 device_site_changed shows the reload message', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'device_site_changed' }), { status: 409 }));
    const onChanged = vi.fn();
    render(<SiteMoveSuggestion {...props({ onChanged })} />);
    fireEvent.click(screen.getByTestId('topology-suggestion-move'));
    fireEvent.click(screen.getByTestId('topology-suggestion-confirm-move'));
    await waitFor(() => expect(screen.getByTestId('topology-suggestion-site-changed')).toBeInTheDocument());
    expect(screen.getByTestId('topology-suggestion-site-changed').textContent).toBe('This device was moved by someone else — reload to see its current site');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'This device was moved by someone else — reload to see its current site' }));
    expect(onChanged).toHaveBeenCalledOnce(); // stale presence is refetched
  });

  it('a 401 is left to the auth redirect: no toast, no refetch', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    const onChanged = vi.fn();
    render(<SiteMoveSuggestion {...props({ onChanged })} />);
    fireEvent.click(screen.getByTestId('topology-suggestion-keep'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showToast).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

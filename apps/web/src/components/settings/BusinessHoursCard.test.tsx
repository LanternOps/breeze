import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BusinessHoursCard from './BusinessHoursCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const claims = vi.hoisted(() => ({ current: { scope: 'partner', orgId: null as string | null, partnerId: 'partner-1' as string | null } }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => claims.current,
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [{ id: 'org-1', name: 'Acme Corp' }] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const CAL_ALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAL_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAL_OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const calendar = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, ownerScope: 'partner', orgId: null, partnerId: 'partner-1', isPartnerDefault: false,
  archivedAt: null, inherited: false,
  currentRevision: {
    id: `rev-${id}`, revision: 1, timezone: 'America/Chicago', createdAt: '2026-01-01T00:00:00Z',
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  },
  holidays: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

let calendars: unknown[] = [];
let handlers: Record<string, (init?: RequestInit) => Response> = {};

function install() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return handler(init);
    if (method === 'GET' && url.startsWith('/business-calendars?')) return json({ data: calendars });
    return json({ error: 'unexpected', code: 'NOPE' }, 404);
  });
}

const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => String(u) === url && ((init as RequestInit)?.method ?? 'GET') === method);

async function renderCard() {
  render(<BusinessHoursCard />);
  await screen.findByTestId('business-hours-list');
}

describe('BusinessHoursCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    calendars = [
      calendar(CAL_ALL, 'Support hours', { isPartnerDefault: true }),
      calendar(CAL_ORG, 'Acme hours', { ownerScope: 'organization', orgId: 'org-1', partnerId: null }),
      calendar(CAL_OLD, 'Legacy', { archivedAt: '2026-02-01T00:00:00Z' }),
    ];
    handlers = {};
    install();
  });

  it('lists calendars with All orgs, Default and Archived markers', async () => {
    await renderCard();
    expect(screen.getByTestId(`business-hours-all-orgs-${CAL_ALL}`).textContent).toBe('All orgs');
    expect(screen.getByTestId(`business-hours-default-${CAL_ALL}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`business-hours-all-orgs-${CAL_ORG}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`business-hours-select-${CAL_ORG}`).textContent).toContain('Acme Corp');
    expect(screen.getByTestId(`business-hours-archived-${CAL_OLD}`)).toBeInTheDocument();
    expect(screen.getByTestId('business-hours-new-tickets-banner').textContent).toMatch(/new tickets only/i);
  });

  it('weekly grid adds a split shift', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId('business-hours-create'));
    // Monday starts with one default shift; add a second one.
    expect(screen.queryByTestId('business-hours-interval-1-1-start')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('business-hours-add-interval-1'));
    fireEvent.change(screen.getByTestId('business-hours-interval-1-1-start'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByTestId('business-hours-interval-1-1-end'), { target: { value: '20:00' } });
    expect((screen.getByTestId('business-hours-interval-1-0-start') as HTMLInputElement).value).toBe('09:00');
    expect((screen.getByTestId('business-hours-interval-1-1-end') as HTMLInputElement).value).toBe('20:00');
    // Sunday is closed; adding opens a default shift, removing closes it again.
    fireEvent.click(screen.getByTestId('business-hours-add-interval-0'));
    expect(screen.getByTestId('business-hours-interval-0-0-start')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('business-hours-remove-interval-0-0'));
    expect(screen.getByTestId('business-hours-closed-0')).toBeInTheDocument();
  });

  it('creating sends a partner-wide calendar with minute intervals', async () => {
    handlers['POST /business-calendars'] = () => json({ data: calendar('new-id', 'Day shift') }, 201);
    await renderCard();
    fireEvent.click(screen.getByTestId('business-hours-create'));
    fireEvent.change(screen.getByTestId('business-hours-name'), { target: { value: 'Day shift' } });
    fireEvent.click(screen.getByTestId('business-hours-save'));
    await waitFor(() => expect(calls('POST', '/business-calendars')).toHaveLength(1));
    const body = JSON.parse((calls('POST', '/business-calendars')[0][1] as RequestInit).body as string);
    expect(body.ownerScope).toBe('partner');
    expect(body.orgId).toBeUndefined();
    expect(body.name).toBe('Day shift');
    expect(body.intervals).toContainEqual({ weekday: 1, startMinute: 540, endMinute: 1020 });
    expect(body.intervals).toHaveLength(5);
  });

  it('owner scope is create-only: editing shows no owner selector', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
    fireEvent.click(screen.getByTestId('business-hours-edit'));
    expect(screen.getByTestId('business-hours-form')).toBeInTheDocument();
    expect(screen.queryByTestId('business-hours-owner-scope')).not.toBeInTheDocument();
  });

  it('overlapping intervals block submit', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId('business-hours-create'));
    fireEvent.change(screen.getByTestId('business-hours-name'), { target: { value: 'Overlap' } });
    fireEvent.click(screen.getByTestId('business-hours-add-interval-1'));
    fireEvent.change(screen.getByTestId('business-hours-interval-1-1-start'), { target: { value: '16:00' } });
    fireEvent.change(screen.getByTestId('business-hours-interval-1-1-end'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByTestId('business-hours-save'));
    expect((await screen.findByTestId('business-hours-form-error')).textContent).toMatch(/must not overlap/i);
    expect(calls('POST', '/business-calendars')).toHaveLength(0);
  });

  it('start after end and an empty week are rejected before submit', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId('business-hours-create'));
    fireEvent.change(screen.getByTestId('business-hours-name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByTestId('business-hours-interval-1-0-end'), { target: { value: '08:00' } });
    fireEvent.click(screen.getByTestId('business-hours-save'));
    expect((await screen.findByTestId('business-hours-form-error')).textContent).toMatch(/end after it starts/i);
    for (const d of [1, 2, 3, 4, 5]) fireEvent.click(screen.getByTestId(`business-hours-remove-interval-${d}-0`));
    fireEvent.click(screen.getByTestId('business-hours-save'));
    expect((await screen.findByTestId('business-hours-form-error')).textContent).toMatch(/at least one open interval/i);
    expect(calls('POST', '/business-calendars')).toHaveLength(0);
  });

  it('shows the holiday hint and toasts when a recompute is queued', async () => {
    handlers[`POST /business-calendars/${CAL_ALL}/holidays`] = () =>
      json({ data: { holiday: { id: 'h1', date: '2030-12-25', name: 'Winter break' }, recomputeQueued: true } }, 201);
    await renderCard();
    fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
    expect(window.location.hash).toBe(`#priorities/${CAL_ALL}`);
    expect(screen.getByTestId('business-hours-holiday-hint').textContent).toBe(
      "Holidays dated today or earlier won't change open tickets.",
    );
    fireEvent.change(screen.getByTestId('business-hours-holiday-date'), { target: { value: '2030-12-25' } });
    fireEvent.change(screen.getByTestId('business-hours-holiday-name'), { target: { value: 'Winter break' } });
    fireEvent.click(screen.getByTestId('business-hours-holiday-add'));
    await waitFor(() => expect(calls('POST', `/business-calendars/${CAL_ALL}/holidays`)).toHaveLength(1));
    expect(JSON.parse((calls('POST', `/business-calendars/${CAL_ALL}/holidays`)[0][1] as RequestInit).body as string))
      .toEqual({ date: '2030-12-25', name: 'Winter break' });
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/deadlines are being updated/i) })),
    );
  });

  it('set default calls the API through runAction (success toast)', async () => {
    calendars = [calendar(CAL_ALL, 'Support hours')];
    await renderCard();
    fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
    handlers[`POST /business-calendars/${CAL_ALL}/default`] = () => json({ data: {} });
    fireEvent.click(screen.getByTestId('business-hours-set-default'));
    await waitFor(() => expect(calls('POST', `/business-calendars/${CAL_ALL}/default`)).toHaveLength(1));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Default calendar set' })),
    );
  });

  it('set default is not offered for organization calendars', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ORG}`));
    expect(screen.queryByTestId('business-hours-set-default')).not.toBeInTheDocument();
  });

  it('surfaces the 409 message when deleting a calendar that is in use', async () => {
    handlers[`DELETE /business-calendars/${CAL_ORG}`] = () => json({ error: 'in use', code: 'CALENDAR_IN_USE' }, 409);
    await renderCard();
    fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ORG}`));
    fireEvent.click(screen.getByTestId('business-hours-delete'));
    fireEvent.click(await screen.findByTestId('business-hours-delete-confirm'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/in use.*Archive it instead/i) })),
    );
  });

  describe('apply to open tickets', () => {
    const PREVIEW_URL = `/business-calendars/${CAL_ALL}/apply-revision/preview`;
    const APPLY_URL = `/business-calendars/${CAL_ALL}/apply-revision`;
    const preview = (revisionId: string) => json({
      data: { revisionId, eligibleCount: 12, immediatelyBreachedCount: 3, skippedPausedCount: 5 },
    });

    it('shows the three counts before confirming and sends expectedRevisionId', async () => {
      handlers[`GET ${PREVIEW_URL}`] = () => preview('rev-1');
      handlers[`POST ${APPLY_URL}`] = () => json({ data: { updated: 12, skippedLocked: 0 } });
      await renderCard();
      fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
      fireEvent.click(screen.getByTestId('business-hours-apply-open'));
      await screen.findByTestId('business-hours-apply-eligible');
      expect(screen.getByTestId('business-hours-apply-eligible').textContent).toContain('12');
      expect(screen.getByTestId('business-hours-apply-breached').textContent).toContain('3');
      expect(screen.getByTestId('business-hours-apply-paused').textContent).toContain('5');
      expect(calls('POST', APPLY_URL)).toHaveLength(0);

      fireEvent.click(screen.getByTestId('business-hours-apply-confirm'));
      await waitFor(() => expect(calls('POST', APPLY_URL)).toHaveLength(1));
      expect(JSON.parse((calls('POST', APPLY_URL)[0][1] as RequestInit).body as string)).toEqual({ expectedRevisionId: 'rev-1' });
    });

    it('rows a concurrent writer held are reported and the dialog stays open with a fresh preview', async () => {
      handlers[`GET ${PREVIEW_URL}`] = () => preview('rev-1');
      handlers[`POST ${APPLY_URL}`] = () => json({ data: { updated: 10, skippedLocked: 2 } });
      await renderCard();
      fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
      fireEvent.click(screen.getByTestId('business-hours-apply-open'));
      await screen.findByTestId('business-hours-apply-eligible');
      fireEvent.click(screen.getByTestId('business-hours-apply-confirm'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('2') })));
      await waitFor(() => expect(calls('GET', PREVIEW_URL)).toHaveLength(2));
      expect(screen.getByTestId('business-hours-apply-confirm')).toBeInTheDocument();
    });

    it('on REVISION_CHANGED tells the user and reloads the preview', async () => {
      let previews = 0;
      handlers[`GET ${PREVIEW_URL}`] = () => preview(`rev-${++previews}`);
      handlers[`POST ${APPLY_URL}`] = () => json({ error: 'changed', code: 'REVISION_CHANGED' }, 409);
      await renderCard();
      fireEvent.click(screen.getByTestId(`business-hours-select-${CAL_ALL}`));
      fireEvent.click(screen.getByTestId('business-hours-apply-open'));
      await screen.findByTestId('business-hours-apply-eligible');
      fireEvent.click(screen.getByTestId('business-hours-apply-confirm'));
      await screen.findByTestId('business-hours-apply-changed');
      await waitFor(() => expect(calls('GET', PREVIEW_URL)).toHaveLength(2));
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/hours changed/i) }));
      // Confirm is available again for the refreshed revision.
      await waitFor(() => expect(screen.getByTestId('business-hours-apply-confirm')).not.toHaveAttribute('disabled'));
    });
  });

  it('renders nothing for an organization-scope user (the calendar API is partner/system only)', async () => {
    claims.current = { scope: 'organization', orgId: 'org-1', partnerId: null };
    try {
      const { container } = render(<BusinessHoursCard />);
      expect(container.innerHTML).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      claims.current = { scope: 'partner', orgId: null, partnerId: 'partner-1' };
    }
  });
});

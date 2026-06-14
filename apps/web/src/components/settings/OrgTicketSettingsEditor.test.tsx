import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgTicketSettingsEditor from './OrgTicketSettingsEditor';
import { fetchWithAuth } from '../../stores/auth';
import { __resetTicketConfigCacheForTests } from '@/lib/ticketConfigApi';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-2222-4333-9444-555566667777';

const SETTINGS = {
  orgId: ORG_ID,
  slaOverrides: {
    urgent: { responseMinutes: 15, resolutionMinutes: 60 },
    high: { responseMinutes: 60, resolutionMinutes: 240 }
  },
  defaultHourlyRate: '125.00',
  defaultBillable: true
};

const PARTNER_CONFIG = {
  data: {
    statuses: [],
    priorities: {
      urgent: { label: null, responseSlaMinutes: 30, resolutionSlaMinutes: 120 },
      high: { label: null, responseSlaMinutes: 120, resolutionSlaMinutes: 480 },
      normal: { label: null, responseSlaMinutes: 240, resolutionSlaMinutes: 960 },
      low: { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null }
    }
  }
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi(settings: unknown = SETTINGS) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/orgs/organizations/${ORG_ID}/ticket-settings` && !init?.method) {
      return makeJsonResponse({ data: settings });
    }
    if (url === `/orgs/organizations/${ORG_ID}/ticket-settings` && init?.method === 'PATCH') {
      return makeJsonResponse({ data: settings });
    }
    if (url === '/ticket-config') {
      return makeJsonResponse(PARTNER_CONFIG);
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('OrgTicketSettingsEditor', () => {
  const onDirty = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTicketConfigCacheForTests();
  });

  it('loads and renders the fetched settings including existing overrides', async () => {
    mockApi();
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-settings')).toBeInTheDocument());

    // Existing override values should be pre-populated
    expect((screen.getByTestId('org-ticket-sla-urgent-response') as HTMLInputElement).value).toBe('15');
    expect((screen.getByTestId('org-ticket-sla-urgent-resolution') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('org-ticket-sla-high-response') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('org-ticket-sla-high-resolution') as HTMLInputElement).value).toBe('240');

    // Priorities without overrides should be blank
    expect((screen.getByTestId('org-ticket-sla-normal-response') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('org-ticket-sla-low-response') as HTMLInputElement).value).toBe('');

    // Billing defaults
    expect((screen.getByTestId('org-ticket-rate') as HTMLInputElement).value).toBe('125.00');
    expect((screen.getByTestId('org-ticket-billable') as HTMLSelectElement).value).toBe('true');
  });

  it('renders partner default values as placeholders when config is available', async () => {
    mockApi();
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-settings')).toBeInTheDocument());

    // Partner config provides values — should show numbers as placeholders
    expect((screen.getByTestId('org-ticket-sla-urgent-response') as HTMLInputElement).placeholder).toBe('30');
    expect((screen.getByTestId('org-ticket-sla-urgent-resolution') as HTMLInputElement).placeholder).toBe('120');

    // Low priority has null SLA in partner config — should show "Partner default"
    expect((screen.getByTestId('org-ticket-sla-low-response') as HTMLInputElement).placeholder).toBe('Partner default');
    expect((screen.getByTestId('org-ticket-sla-low-resolution') as HTMLInputElement).placeholder).toBe('Partner default');
  });

  it('shows "Partner default" placeholder when no partner config is available', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/orgs/organizations/${ORG_ID}/ticket-settings` && !init?.method) {
        return makeJsonResponse({ data: SETTINGS });
      }
      if (url === `/orgs/organizations/${ORG_ID}/ticket-settings` && init?.method === 'PATCH') {
        return makeJsonResponse({ data: SETTINGS });
      }
      if (url === '/ticket-config') {
        return makeJsonResponse({ error: 'fail' }, false, 500);
      }
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });

    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-settings')).toBeInTheDocument());
    expect((screen.getByTestId('org-ticket-sla-urgent-response') as HTMLInputElement).placeholder).toBe('Partner default');
  });

  it('sends wholesale slaOverrides (all non-blank cells), rate as number, billable correctly on save', async () => {
    mockApi({
      orgId: ORG_ID,
      slaOverrides: {},
      defaultHourlyRate: null,
      defaultBillable: null
    });
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-save')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-ticket-sla-urgent-response'), { target: { value: '15' } });
    fireEvent.change(screen.getByTestId('org-ticket-sla-urgent-resolution'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('org-ticket-sla-high-response'), { target: { value: '120' } });
    // high resolution left blank — key absent from urgent's object
    fireEvent.change(screen.getByTestId('org-ticket-rate'), { target: { value: '150' } });
    fireEvent.change(screen.getByTestId('org-ticket-billable'), { target: { value: 'false' } });

    fireEvent.click(screen.getByTestId('org-ticket-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall![1]!.body));

    // slaOverrides replaces wholesale — only non-blank cells present
    expect(body.slaOverrides).toEqual({
      urgent: { responseMinutes: 15, resolutionMinutes: 60 },
      high: { responseMinutes: 120 }
    });

    // defaultHourlyRate is sent as a number, not string
    expect(body.defaultHourlyRate).toBe(150);
    expect(typeof body.defaultHourlyRate).toBe('number');

    // defaultBillable is boolean false
    expect(body.defaultBillable).toBe(false);
  });

  it('sends null defaultHourlyRate when hourly rate field is blank', async () => {
    mockApi({
      orgId: ORG_ID,
      slaOverrides: {},
      defaultHourlyRate: null,
      defaultBillable: null
    });
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-ticket-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body.defaultHourlyRate).toBeNull();
    expect(body.defaultBillable).toBeNull();
    expect(body.slaOverrides).toEqual({});
  });

  it('sends empty slaOverrides object when all cells are blank (clears all overrides)', async () => {
    // Start with existing overrides to confirm they get cleared
    mockApi();
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-save')).toBeInTheDocument());

    // Clear all the pre-populated override values
    fireEvent.change(screen.getByTestId('org-ticket-sla-urgent-response'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('org-ticket-sla-urgent-resolution'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('org-ticket-sla-high-response'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('org-ticket-sla-high-resolution'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('org-ticket-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body.slaOverrides).toEqual({});
  });

  it('shows an error state with retry when the load fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-load-error')).toBeInTheDocument());
  });

  it('does not call onSave when the PATCH fails (runAction toasts the error)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') return makeJsonResponse({ error: 'nope' }, false, 500);
      if (url === '/ticket-config') return makeJsonResponse(PARTNER_CONFIG);
      return makeJsonResponse({ data: SETTINGS });
    });
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-save')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-ticket-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('redirects to /login on 401 during load', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('marks dirty when an SLA field changes', async () => {
    mockApi();
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-sla-normal-response')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('org-ticket-sla-normal-response'), { target: { value: '240' } });
    expect(onDirty).toHaveBeenCalled();
  });

  it('save button is disabled while saving', async () => {
    // Use a slow PATCH to observe the in-flight state
    let resolvePatch!: (r: Response) => void;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        return new Promise<Response>(resolve => { resolvePatch = resolve; });
      }
      if (url === '/ticket-config') return makeJsonResponse(PARTNER_CONFIG);
      return makeJsonResponse({ data: SETTINGS });
    });
    render(<OrgTicketSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-ticket-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-ticket-save'));
    await waitFor(() => expect((screen.getByTestId('org-ticket-save') as HTMLButtonElement).disabled).toBe(true));

    // Resolve so the component doesn't linger
    resolvePatch(makeJsonResponse({ data: SETTINGS }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});

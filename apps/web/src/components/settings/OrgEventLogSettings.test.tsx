import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

import OrgEventLogSettings from './OrgEventLogSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// The header switcher sits on a DIFFERENT org than the one the settings page
// is editing (`/settings/organizations/<orgId>`): nothing here may read it.
const { SWITCHER_ORG, PAGE_ORG } = vi.hoisted(() => ({
  SWITCHER_ORG: 'org-switcher',
  PAGE_ORG: 'org-1',
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({ currentOrgId: SWITCHER_ORG }),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const SAVED_PLACEHOLDER = () => i18n.t('settings:orgEventLogSettings.authentication.savedSecretPlaceholder');

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function loadWith(logForwarding: Record<string, unknown>) {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'PATCH') {
      return jsonResponse({ success: true, settings: { logForwarding } });
    }
    return jsonResponse({ settings: { logForwarding } });
  });
}

function patchBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]!.body));
}

describe('OrgEventLogSettings: saved credentials', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('shows a saved API key as a placeholder instead of putting the marker in the field', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', elasticsearchApiKey: '********', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);

    const input = await screen.findByPlaceholderText(SAVED_PLACEHOLDER());
    expect(input).toHaveValue('');
    expect(screen.queryByDisplayValue('********')).toBeNull();
  });

  it('keeps the saved API key when the field is left untouched', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', elasticsearchApiKey: '********', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);
    await screen.findByPlaceholderText(SAVED_PLACEHOLDER());

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchBody().elasticsearchApiKey).toBe('********'));
  });

  it('replaces the saved API key with a typed value', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', elasticsearchApiKey: '********', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);
    const input = await screen.findByPlaceholderText(SAVED_PLACEHOLDER());

    fireEvent.change(input, { target: { value: 'new-typed-key' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchBody().elasticsearchApiKey).toBe('new-typed-key'));
  });

  it('keeps a saved basic-auth password when left untouched', async () => {
    loadWith({
      enabled: true,
      elasticsearchUrl: 'https://es.test:9200',
      elasticsearchUsername: 'svc',
      elasticsearchPassword: '********',
      indexPrefix: 'breeze-logs',
    });
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);
    const input = await screen.findByPlaceholderText(SAVED_PLACEHOLDER());
    expect(input).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const body = patchBody();
      expect(body.elasticsearchUsername).toBe('svc');
      expect(body.elasticsearchPassword).toBe('********');
    });
  });

  it('uses the ordinary placeholder when nothing is saved', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);

    await screen.findByPlaceholderText(i18n.t('settings:orgEventLogSettings.authentication.apiKeyPlaceholder'));
    expect(screen.queryByPlaceholderText(SAVED_PLACEHOLDER())).toBeNull();
  });
});

// Pre-release sweep (v0.118.2 → main): on `/settings/organizations/<B>#event-logs`
// with the header switcher on org A, the tab loaded and SAVED org A's log
// forwarding while the page named org B.
describe('OrgEventLogSettings: org scoping', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', indexPrefix: 'breeze-logs' });
  });

  it('loads and saves the org it is given, never the header switcher org', async () => {
    render(<OrgEventLogSettings orgId={PAGE_ORG} />);
    await screen.findByDisplayValue('https://es.test:9200');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      `/agents/org/${PAGE_ORG}/settings/log-forwarding`,
      `/agents/org/${PAGE_ORG}/settings/log-forwarding`,
    ]);
    expect(urls.some((u) => u.includes(SWITCHER_ORG))).toBe(false);
  });

  // The page re-posts the whole settings blob on its section saves, so it must
  // hear about this own-route write or its next save reverts it.
  it('reports a successful save to the page, and a failed one not at all', async () => {
    const onSaved = vi.fn();
    const { unmount } = render(<OrgEventLogSettings orgId={PAGE_ORG} onSaved={onSaved} />);
    await screen.findByDisplayValue('https://es.test:9200');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    unmount();

    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'PATCH'
        ? ({ ok: false, status: 400, json: vi.fn().mockResolvedValue({ error: 'nope' }) } as unknown as Response)
        : jsonResponse({ settings: { logForwarding: { enabled: true, elasticsearchUrl: 'https://es.test:9200' } } }),
    );
    const onFailedSave = vi.fn();
    render(<OrgEventLogSettings orgId={PAGE_ORG} onSaved={onFailedSave} />);
    await screen.findByDisplayValue('https://es.test:9200');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText('nope');
    expect(onFailedSave).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

import OrgEventLogSettings from './OrgEventLogSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({ currentOrgId: 'org-1' }),
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
    render(<OrgEventLogSettings />);

    const input = await screen.findByPlaceholderText(SAVED_PLACEHOLDER());
    expect(input).toHaveValue('');
    expect(screen.queryByDisplayValue('********')).toBeNull();
  });

  it('keeps the saved API key when the field is left untouched', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', elasticsearchApiKey: '********', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings />);
    await screen.findByPlaceholderText(SAVED_PLACEHOLDER());

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchBody().elasticsearchApiKey).toBe('********'));
  });

  it('replaces the saved API key with a typed value', async () => {
    loadWith({ enabled: true, elasticsearchUrl: 'https://es.test:9200', elasticsearchApiKey: '********', indexPrefix: 'breeze-logs' });
    render(<OrgEventLogSettings />);
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
    render(<OrgEventLogSettings />);
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
    render(<OrgEventLogSettings />);

    await screen.findByPlaceholderText(i18n.t('settings:orgEventLogSettings.authentication.apiKeyPlaceholder'));
    expect(screen.queryByPlaceholderText(SAVED_PLACEHOLDER())).toBeNull();
  });
});

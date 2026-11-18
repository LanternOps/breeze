import '@/lib/i18n';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorEditor, { editorHashForTab } from './MonitorEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: {} }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'organization' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const KINDS = ['cpu', 'service', 'process'].map(kind => ({
  kind, overridableKeys: [], defaultSeverity: 'high', agentDelivered: kind !== 'cpu',
}));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/monitor-definitions/kinds')) return json({ data: KINDS });
    return json({ data: [], inherited: [] });
  });
});
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

describe('MonitorEditor "Monitor this" prefill (#10927)', () => {
  it.each([
    { kind: 'service', param: 'serviceName', field: 'condition-field-serviceName', value: 'Affiniti_Device_manager' },
    { kind: 'process', param: 'processName', field: 'condition-field-processName', value: 'chrome.exe' },
  ])('prefills the $kind name and monitor name from the hash', async ({ kind, param, field, value }) => {
    window.history.replaceState(null, '', `/alerts/monitors/new#kind=${kind}&${param}=${encodeURIComponent(value)}`);
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId(field)).toHaveValue(value));
    expect(screen.getByTestId('monitor-editor-kind')).toHaveValue(kind);
    expect((screen.getByTestId('monitor-editor-name') as HTMLInputElement).value).toContain(value);
  });

  it('keeps the placeholder condition when the hash carries no name', async () => {
    window.history.replaceState(null, '', '/alerts/monitors/new#kind=service');
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('condition-field-serviceName')).toHaveValue('MyService'));
  });

  it('round-trips special characters through the hash', async () => {
    window.history.replaceState(null, '', `/alerts/monitors/new#kind=process&processName=${encodeURIComponent('a b&c+d.exe')}`);
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('condition-field-processName')).toHaveValue('a b&c+d.exe'));
  });

  it('keeps the name params when the tab hash is rewritten', () => {
    const next = new URLSearchParams(editorHashForTab('#kind=service&serviceName=Spooler', 'settings').slice(1));
    expect(next.get('serviceName')).toBe('Spooler');
    expect(next.get('kind')).toBe('service');
  });
});

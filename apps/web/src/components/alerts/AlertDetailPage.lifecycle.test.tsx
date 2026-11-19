import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

import AlertDetailPage from './AlertDetailPage';
import { useOrgStore } from '@/stores/orgStore';

const SOURCES = { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' };
const SNAPSHOT = {
  autoResolve: true,
  rearmMode: 'new_evidence',
  rearmDelayMinutes: null,
  cooldownMinutes: 5,
  sources: SOURCES,
  monitorCompiledHash: 'abc',
  cursor: {},
};
const baseAlert = {
  id: 'a-1',
  title: 'UPS on battery',
  message: 'Battery',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

async function renderWithContext(context: unknown) {
  fetchWithAuth.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url.endsWith('/tickets') ? { data: [] } : { ...baseAlert, context }),
    }),
  );
  render(<AlertDetailPage alertId={baseAlert.id} />);
  await screen.findByRole('heading', { name: baseAlert.title });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  useOrgStore.setState({ serviceManagementMode: 'native' });
});

describe('AlertDetailPage lifecycle line', () => {
  it('alert detail renders the lifecycle line from the snapshot', async () => {
    await renderWithContext({ lifecycle: SNAPSHOT });
    expect(screen.getByTestId('alert-lifecycle-line')).toHaveTextContent(
      'Re-arms on new evidence · cooldown 5 min (partner default)',
    );
  });

  it('after_delay says how long', async () => {
    await renderWithContext({ lifecycle: { ...SNAPSHOT, rearmMode: 'after_delay', rearmDelayMinutes: 45 } });
    expect(screen.getByTestId('alert-lifecycle-line')).toHaveTextContent('Re-arms after 45 min · cooldown 5 min');
  });

  it.each([
    ['monitor', 'this monitor'],
    ['org', 'org default'],
    ['partner', 'partner default'],
    ['builtin', 'built-in default'],
    ['legacy', 'alert rule'],
  ])('names the cooldown source %s', async (source, label) => {
    await renderWithContext({ lifecycle: { ...SNAPSHOT, sources: { ...SOURCES, cooldownMinutes: source } } });
    expect(screen.getByTestId('alert-lifecycle-line')).toHaveTextContent(`(${label})`);
  });

  it('a zero cooldown is still shown', async () => {
    await renderWithContext({ lifecycle: { ...SNAPSHOT, cooldownMinutes: 0 } });
    expect(screen.getByTestId('alert-lifecycle-line')).toHaveTextContent('cooldown 0 min');
  });

  it.each([
    ['no context', undefined],
    ['a context with no lifecycle', { other: 1 }],
    ['a W1 context holding only the cursor', { lifecycle: { cursor: { root: {} } } }],
    ['an unknown re-arm mode', { lifecycle: { ...SNAPSHOT, rearmMode: 'sometimes' } }],
    ['after_delay with no minutes', { lifecycle: { ...SNAPSHOT, rearmMode: 'after_delay', rearmDelayMinutes: null } }],
    ['a non-numeric cooldown', { lifecycle: { ...SNAPSHOT, cooldownMinutes: 'five' } }],
    ['an unknown source', { lifecycle: { ...SNAPSHOT, sources: { ...SOURCES, cooldownMinutes: 'astrology' } } }],
    ['no sources', { lifecycle: { ...SNAPSHOT, sources: undefined } }],
  ])('alert without a snapshot renders no line: %s', async (_name, context) => {
    await renderWithContext(context);
    expect(screen.queryByTestId('alert-lifecycle-line')).toBeNull();
  });
});

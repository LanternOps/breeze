import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { topologySettingsFixture, SITE } from './topologyFixtures';
import TopologyConfiguration from './TopologyConfiguration';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
afterEach(cleanup);
it('read-only users inspect eligible published choices without mutation authority', async () => {
  const settings = topologySettingsFixture(); settings.permissions.canEdit = false; settings.permissions.canConfigureMonitoring = false;
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('settings') ? settings : { items: [], nextCursor: null })));
  render(<TopologyConfiguration siteId={SITE} />);
  expect(await screen.findByTestId('topology-template-preview')).toBeDisabled();
  expect(screen.getByTestId('topology-configuration-save')).toBeDisabled();
  expect(screen.getByTestId('topology-enable-recurring')).toBeDisabled();
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

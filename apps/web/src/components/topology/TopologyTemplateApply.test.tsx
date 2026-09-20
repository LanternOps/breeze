import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import TopologyTemplateApply from './TopologyTemplateApply';
import { SITE } from './topologyFixtures';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });
afterEach(cleanup);
const request = { partnerVersionId: null, orgVersionId: null, sites: [{ siteId: SITE, expectedBindingRevision: '1', enableRecurring: false }] };
it('preview is review-only and does not enable monitoring or apply a template', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ token: 'opaque', expiresAt: new Date(Date.now() + 600000).toISOString(), sites: [{ siteId: SITE, expectedBindingRevision: '1', effects: [], errors: [] }] })));
  render(<TopologyTemplateApply request={request} canApply onComplete={() => {}} />);
  fireEvent.click(screen.getByTestId('topology-template-preview'));
  expect(await screen.findByTestId('topology-template-diff')).toBeVisible();
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetchWithAuth).mock.calls[0][0]).toBe('/topology/template-applications/preview');
  expect(screen.getByTestId('topology-enable-recurring')).toBeDisabled();
});
it('an expired preview disables apply', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ token: 'opaque', expiresAt: '2020-01-01T00:00:00Z', sites: [] })));
  render(<TopologyTemplateApply request={request} canApply onComplete={() => {}} />);
  fireEvent.click(screen.getByTestId('topology-template-preview'));
  expect(await screen.findByTestId('topology-template-apply')).toBeDisabled();
});

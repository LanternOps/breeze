import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyEmptyState from './TopologyEmptyState';

const auth = vi.hoisted(() => ({ scope: 'partner' as 'system' | 'partner' | 'organization' | null }));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: auth.scope, orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: auth.scope, orgId: null, partnerId: 'partner-1' }),
}));

beforeEach(() => { auth.scope = 'partner'; });
afterEach(cleanup);

it('materialization_disabled: tells a partner admin the module is off and links to Modules settings', () => {
  render(<TopologyEmptyState reason="materialization_disabled" />);
  const root = screen.getByTestId('topology-empty-state');
  expect(screen.getByRole('heading')).toHaveTextContent('Network Topology is off');
  expect(root).toHaveTextContent('A partner admin can turn it on in Settings → Modules.');
  const link = screen.getByRole('link', { name: 'Open Modules settings' });
  expect(link).toHaveAttribute('href', '/settings/partner#modules');
  expect(root.textContent).not.toContain('materialization_disabled');
  expect(root.querySelector('details')).toBeNull();
});

it('ui_disabled: same off state as materialization_disabled', () => {
  render(<TopologyEmptyState reason="ui_disabled" />);
  expect(screen.getByRole('heading')).toHaveTextContent('Network Topology is off');
  expect(screen.getByRole('link', { name: 'Open Modules settings' })).toHaveAttribute('href', '/settings/partner#modules');
  expect(screen.getByTestId('topology-empty-state').textContent).not.toContain('ui_disabled');
});

it('off state for an org-scoped user: no settings link, asks the MSP instead', () => {
  auth.scope = 'organization';
  render(<TopologyEmptyState reason="materialization_disabled" />);
  const root = screen.getByTestId('topology-empty-state');
  expect(screen.getByRole('heading')).toHaveTextContent('Network Topology is off');
  expect(root).toHaveTextContent('Ask your MSP to enable it.');
  expect(root).not.toHaveTextContent('Settings → Modules');
  expect(screen.queryByRole('link')).toBeNull();
});

it('off state before the token has resolved: no settings link (server decides)', () => {
  auth.scope = null;
  render(<TopologyEmptyState reason="ui_disabled" />);
  expect(screen.queryByRole('link')).toBeNull();
});

it('topology_preparing: building state with a live status region and no settings link', () => {
  render(<TopologyEmptyState reason="topology_preparing" />);
  const root = screen.getByTestId('topology-empty-state');
  expect(screen.getByRole('heading')).toHaveTextContent('Building the topology map');
  expect(root).toHaveTextContent('This usually completes within a few minutes of enabling the feature.');
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
  expect(root.textContent).not.toContain('topology_preparing');
});

it('unknown reason: generic unavailable copy, raw code only inside a collapsed <details>', () => {
  render(<TopologyEmptyState reason="some_future_code" />);
  const root = screen.getByTestId('topology-empty-state');
  expect(screen.getByRole('heading')).toHaveTextContent('Topology unavailable');
  expect(screen.getByRole('heading').textContent).not.toContain('some_future_code');
  for (const p of root.querySelectorAll('p')) expect(p.textContent).not.toContain('some_future_code');
  const details = root.querySelector('details');
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute('open');
  expect(details?.textContent).toContain('some_future_code');
  expect(screen.queryByRole('link')).toBeNull();
});

it('null reason: generic unavailable copy without a details block', () => {
  render(<TopologyEmptyState reason={null} />);
  expect(screen.getByRole('heading')).toHaveTextContent('Topology unavailable');
  expect(screen.getByTestId('topology-empty-state').querySelector('details')).toBeNull();
});

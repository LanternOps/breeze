import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import TopologySiteRoster from './TopologySiteRoster';
import type { RosterNetwork } from './renderProjection';

const D1 = '00000000-0000-4000-8000-000000000001', D2 = '00000000-0000-4000-8000-000000000002', D3 = '00000000-0000-4000-8000-000000000003';
const nodes = new Map([[D1, { label: 'DESKTOP-HD7K2QF' }], [D2, { label: 'WIN-HD4M8T2C9' }], [D3, { label: 'LAB-PRINTER-04' }]]);
const undeclared: RosterNetwork = { groupId: 'g1', prefix: '10.1.5.0/24', gatewayAddresses: ['10.1.5.1'], kind: 'undeclared', memberNodeIds: [D1, D2] };
afterEach(cleanup);

it('renders a collapsed roster with a count chip, expands to networks and devices, and selects a device', async () => {
  const onSelect = vi.fn();
  render(<TopologySiteRoster siteName="Main Office" roster={[undeclared]} nodesById={nodes} onSelect={onSelect} />);
  const toggle = screen.getByRole('button', { name: /Other \/ unidentified networks \(2\)/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('10.1.5.0/24 via 10.1.5.1')).toBeNull();
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('10.1.5.0/24 via 10.1.5.1')).toBeInTheDocument();
  expect(screen.getByText('Not declared for Main Office')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /DESKTOP-HD7K2QF/ }));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: D1 });
  expect(screen.getByTestId('topology-site-roster').textContent).not.toMatch(/away/i);
});

it('counts distinct devices across entries and words an unidentified entry as not identified', async () => {
  const unidentified: RosterNetwork = { groupId: 'g2', prefix: null, gatewayAddresses: [], kind: 'unidentified', memberNodeIds: [D2, D3] };
  render(<TopologySiteRoster siteName="Main Office" roster={[undeclared, unidentified]} nodesById={nodes} onSelect={vi.fn()} />);
  const toggle = screen.getByRole('button', { name: /Other \/ unidentified networks \(3\)/ });
  await userEvent.click(toggle);
  expect(screen.getByText('Network not identified')).toBeInTheDocument();
  expect(screen.getByText('10.1.5.0/24 via 10.1.5.1')).toBeInTheDocument();
  expect(screen.getByTestId('topology-site-roster').textContent).not.toMatch(/away/i);
});

it('shows just the prefix when the network reports no gateway, and renders nothing for an empty roster', async () => {
  const { rerender } = render(<TopologySiteRoster siteName="Main Office" roster={[{ ...undeclared, gatewayAddresses: [] }]} nodesById={nodes} onSelect={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /Other \/ unidentified networks/ }));
  expect(screen.getByText('10.1.5.0/24')).toBeInTheDocument();
  rerender(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} />);
  expect(screen.queryByTestId('topology-site-roster')).toBeNull();
});

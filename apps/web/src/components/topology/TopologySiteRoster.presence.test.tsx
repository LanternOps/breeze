import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import TopologySiteRoster from './TopologySiteRoster';
import type { RosterNetwork } from './renderProjection';
import { formatTime } from '../../lib/dateTimeFormat';
import { LAKESIDE, MAIN_OFFICE, presenceAssigned, presenceDeviceId, presenceFixture } from './presenceFixtures';

const D1 = '00000000-0000-4000-8000-000000000001', D2 = '00000000-0000-4000-8000-000000000002';
const nodes = new Map([[D1, { label: 'DESKTOP-HD7K2QF' }], [D2, { label: 'WIN-HD4M8T2C9' }]]);
const undeclared: RosterNetwork = { groupId: 'g1', prefix: '10.1.5.0/24', gatewayAddresses: ['10.1.5.1'], kind: 'undeclared', memberNodeIds: [D1, D2] };
afterEach(cleanup);

const linked = (...numbers: number[]) => new Map(numbers.map((n) => [presenceDeviceId(n), `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`]));
const openRoster = async () => userEvent.click(screen.getByRole('button', { name: /Devices not on this site's networks/ }));
const section = (name: RegExp) => within(screen.getByRole('region', { name }));
const day = 86_400_000;

it('lists a visiting device under "Observed at other sites" with the matched site, prefix and time, and opens the inspector for it', async () => {
  const onSelect = vi.fn();
  const presence = presenceFixture({ assigned: [presenceAssigned(1)], counts: { observedElsewhere: 1, unidentified: 0, unknown: 0, visiting: 0 } });
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={onSelect} presence={presence} deviceNodeIds={linked(1)} />);
  expect(screen.getByRole('button', { name: /Devices not on this site's networks \(1\)/ })).toHaveAttribute('aria-expanded', 'false');
  await openRoster();
  const observed = section(/^Observed at other sites/);
  const since = formatTime('2026-10-12T09:12:00Z', { hour: '2-digit', minute: '2-digit' });
  expect(observed.getByText(`On ${LAKESIDE.name}'s network (10.1.5.0/24) · since ${since}`)).toBeInTheDocument();
  await userEvent.click(observed.getByRole('button', { name: /DESKTOP-HD7K2QF/ }));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: linked(1).get(presenceDeviceId(1)) });
});

it('hidden match (state unrecognized, reason null) renders under "Other / unidentified networks" with no hint', async () => {
  const hidden = presenceAssigned(2, { label: 'LAPTOP-HOME-01', state: 'unrecognized', reason: null, matchedSite: null, macCorroborated: false, network: { prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1' } });
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: [hidden] })} deviceNodeIds={linked(2)} />);
  await openRoster();
  const other = section(/^Other \/ unidentified networks/);
  expect(other.getByText("192.168.1.0/24 via 192.168.1.1 — not identified as any site's network")).toBeInTheDocument();
  expect(other.queryByText(/Declared for|Common home-router|different gateway/)).toBeNull();
  expect(screen.queryByText(/Lakeside/)).toBeNull();
});

it('shows a reason hint only for the listed reasons and only when the named site is given', async () => {
  const entries = [
    presenceAssigned(3, { label: 'WIN-A', state: 'unrecognized', reason: 'declared_unconfirmed' }),
    presenceAssigned(4, { label: 'WIN-B', state: 'unrecognized', reason: 'consumer_uncorroborated' }),
    presenceAssigned(5, { label: 'WIN-C', state: 'unrecognized', reason: 'gateway_mismatch' }),
    presenceAssigned(6, { label: 'WIN-D', state: 'unrecognized', reason: 'own_gateway_mismatch', matchedSite: null, network: { prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.254' } }),
    presenceAssigned(7, { label: 'WIN-E', state: 'unrecognized', reason: 'gateway_mac_conflict' }),
    presenceAssigned(8, { label: 'WIN-F', state: 'unrecognized', reason: 'declared_unconfirmed', matchedSite: null }),
  ];
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: entries })} deviceNodeIds={linked(3, 4, 5, 6, 7, 8)} />);
  await openRoster();
  const other = section(/^Other \/ unidentified networks/);
  expect(other.getByText('Declared for Lakeside, but no Lakeside device confirms this gateway yet.')).toBeInTheDocument();
  expect(other.getByText("Common home-router range. The router could not be matched to Lakeside's.")).toBeInTheDocument();
  expect(other.getByText("In Lakeside's declared range, but through a different gateway.")).toBeInTheDocument();
  expect(other.getByText("In Main Office's declared range, but through a different gateway (10.1.2.254).")).toBeInTheDocument();
  expect(other.getAllByText(/^(Declared for|In |Common home-router)/)).toHaveLength(4);
});

it('names both declaring sites for an ambiguous device, and treats an ambiguous device without them as unrecognized', async () => {
  const entries = [
    presenceAssigned(3, { label: 'WIN-A', state: 'ambiguous', reason: 'multiply_declared', matchedSite: null, declaringSites: [MAIN_OFFICE, LAKESIDE] }),
    presenceAssigned(4, { label: 'WIN-B', state: 'ambiguous', reason: null, matchedSite: null, declaringSites: null }),
  ];
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: entries })} deviceNodeIds={linked(3, 4)} />);
  await openRoster();
  const other = section(/^Other \/ unidentified networks/);
  expect(other.getByText("Declared for Main Office and Lakeside. Breeze can't tell which site this is.")).toBeInTheDocument();
  expect(other.getAllByText(/not identified as any site's network/)).toHaveLength(1);
});

it('lists stale and unknown devices under "Location unknown": last reported network and age, or "Location not current"', async () => {
  const entries = [
    presenceAssigned(3, { label: 'LAPTOP-OLD', state: 'stale', reason: 'no_fresh_observation', matchedSite: null, observedAt: new Date(Date.now() - 3 * day).toISOString() }),
    presenceAssigned(4, { label: 'LAPTOP-NOW', state: 'unknown', reason: 'not_current', matchedSite: null, observedAt: new Date(Date.now() - 3 * day).toISOString() }),
    presenceAssigned(5, { label: 'LAPTOP-LIM', state: 'unknown', reason: 'coverage_limited', matchedSite: null, network: null, observedAt: null }),
  ];
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: entries })} deviceNodeIds={linked(3, 4, 5)} />);
  await openRoster();
  const unknown = section(/^Location unknown/);
  expect(unknown.getByText('Last reported 10.1.5.0/24 via 10.1.5.1, 3 days ago')).toBeInTheDocument();
  expect(unknown.getAllByText('Location not current')).toHaveLength(2);
});

it('keeps W01 undeclared networks in the "Other / unidentified networks" section next to presence entries, counting each device once', async () => {
  const hidden = presenceAssigned(2, { label: 'LAPTOP-HOME-01', state: 'unrecognized', matchedSite: null });
  render(<TopologySiteRoster siteName="Main Office" roster={[undeclared]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: [hidden] })} deviceNodeIds={linked(2)} />);
  expect(screen.getByRole('button', { name: /Devices not on this site's networks \(3\)/ })).toBeInTheDocument();
  await openRoster();
  const other = section(/^Other \/ unidentified networks/);
  expect(other.getByText('10.1.5.0/24 via 10.1.5.1')).toBeInTheDocument();
  expect(other.getByRole('button', { name: /DESKTOP-HD7K2QF/ })).toBeInTheDocument();
  expect(other.getByText(/LAPTOP-HOME-01/)).toBeInTheDocument();
});

it('never renders the word "away" in any roster section', async () => {
  const entries = [presenceAssigned(1), presenceAssigned(2, { label: 'A', state: 'unrecognized', reason: 'gateway_mismatch' }),
    presenceAssigned(3, { label: 'B', state: 'ambiguous', reason: 'multiply_declared', declaringSites: [MAIN_OFFICE, LAKESIDE] }),
    presenceAssigned(4, { label: 'C', state: 'stale', reason: 'no_fresh_observation', observedAt: new Date(Date.now() - day).toISOString() }),
    presenceAssigned(5, { label: 'D', state: 'unknown', reason: 'not_current' })];
  render(<TopologySiteRoster siteName="Main Office" roster={[undeclared]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: entries })} deviceNodeIds={linked(1, 2, 3, 4, 5)} />);
  await openRoster();
  expect(screen.getByRole('region', { name: /^Observed at other sites/ })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /^Other \/ unidentified networks/ })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /^Location unknown/ })).toBeInTheDocument();
  expect(screen.getByTestId('topology-site-roster').textContent).not.toMatch(/away/i);
});

it('renders a device with no node on this map as plain text, not a button', async () => {
  render(<TopologySiteRoster siteName="Main Office" roster={[]} nodesById={nodes} onSelect={vi.fn()} presence={presenceFixture({ assigned: [presenceAssigned(1)] })} deviceNodeIds={new Map()} />);
  await openRoster();
  expect(screen.queryByRole('button', { name: /DESKTOP-HD7K2QF/ })).toBeNull();
  expect(screen.getByText('DESKTOP-HD7K2QF')).toBeInTheDocument();
});

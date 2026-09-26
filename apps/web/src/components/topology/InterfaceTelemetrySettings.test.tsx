import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GraphResponse } from '@breeze/shared';
import { diagnosticPlanFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import InterfaceTelemetrySettings from './InterfaceTelemetrySettings';
import { monitoringFixture, OPS, telemetryArmFixture } from './operationsFixtures';
import { topologyGraphFixture } from './topologyFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const origin = diagnosticPlanFixture().origin;
function graph(): GraphResponse {
  const base = topologyGraphFixture();
  const node = base.nodes[0]!;
  return { ...base,
    nodes: [node, { ...node, id: OPS.peer, label: 'Desk switch', bindings: [] }],
    relationships: [{ id: OPS.relationship, kind: 'physical_link', directionality: 'undirected', sourceNodeId: node.id, targetNodeId: OPS.peer,
      sourceInterfaceId: OPS.port, targetInterfaceId: OPS.peerPort, meaning: 'physical', directness: 'direct',
      evidence: { classes: ['observed'], methods: ['lldp'], count: '1', lastObservedAt: '2026-09-26T10:00:00.000Z' }, confidence: 'high', lifecycle: 'active', freshness: 'fresh',
      health: node.health, excluded: false, availableActions: [] }] };
}
let arms = [] as ReturnType<typeof telemetryArmFixture>[];
beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset(); vi.mocked(showToast).mockReset(); arms = [];
  vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/devices?')) return json({ data: [{ id: origin.deviceId, hostname: 'poller-01', displayName: null, status: 'online' }] });
    if (url.startsWith('/discovery/profiles')) return json({ data: [
      { id: OPS.profile, siteId: OPS.site, name: 'Core SNMP', enabled: true, methods: ['snmp', 'ping'] },
      { id: OPS.user, siteId: OPS.site, name: 'Ping only', enabled: true, methods: ['ping'] },
    ] });
    if (url.includes('/monitoring')) return json(monitoringFixture({}, arms));
    if (url.endsWith('/telemetry-arms') && init?.method === 'POST') { arms = [telemetryArmFixture()]; return json(telemetryArmFixture(), 201); }
    if (url.includes('/telemetry-arms/') && init?.method === 'DELETE') { arms = [telemetryArmFixture({ state: 'revoked' })]; return json(telemetryArmFixture({ state: 'revoked' })); }
    return json({ error: 'unexpected' }, 500);
  });
});
afterEach(() => cleanup());
const mutations = () => vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

it('lists only canonical ports, previews volume and mapping, and arms explicitly with the selection', async () => {
  render(<InterfaceTelemetrySettings siteId={OPS.site} nodeId={OPS.node} graph={graph()} canConfigure />);
  const port = await screen.findByTestId(`topology-telemetry-port-${OPS.port}`);
  expect(port.closest('label')).toHaveTextContent('Port to Desk switch');
  await waitFor(() => expect(screen.getByTestId('topology-telemetry-credential')).toHaveTextContent('Core SNMP'));
  expect(screen.getByTestId('topology-telemetry-credential')).not.toHaveTextContent('Ping only');
  fireEvent.click(port);
  fireEvent.change(screen.getByTestId('topology-telemetry-collector'), { target: { value: origin.deviceId } });
  fireEvent.change(screen.getByTestId('topology-telemetry-credential'), { target: { value: OPS.profile } });
  fireEvent.click(screen.getByTestId('topology-telemetry-preview'));
  expect(screen.getByTestId('topology-telemetry-volume')).toHaveTextContent('1440 samples per day');
  expect(mutations()).toEqual([]);
  fireEvent.click(screen.getByTestId('topology-telemetry-enable'));
  await screen.findByTestId(`topology-telemetry-arm-${OPS.arm}`);
  const [url, init] = mutations()[0]!;
  expect(String(url)).toBe(`/topology/sites/${OPS.site}/telemetry-arms`);
  expect(JSON.parse(String(init!.body))).toEqual({ targetNodeId: OPS.node, collectorDeviceId: origin.deviceId, credentialProfileId: OPS.profile, interfaceIds: [OPS.port], intervalSeconds: 60, ttlDays: 30 });
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Port measurement turned on' }));
});

it('revokes an arm without step-up and shows a device with no known ports as not identified', async () => {
  arms = [telemetryArmFixture()];
  render(<InterfaceTelemetrySettings siteId={OPS.site} nodeId={OPS.node} graph={graph()} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-telemetry-revoke'));
  await waitFor(() => expect(screen.getByTestId(`topology-telemetry-arm-${OPS.arm}`)).toHaveTextContent('Off'));
  expect(String(mutations()[0]![0])).toBe(`/topology/sites/${OPS.site}/telemetry-arms/${OPS.arm}`);
  cleanup();
  render(<InterfaceTelemetrySettings siteId={OPS.site} nodeId={OPS.peer} graph={{ ...graph(), relationships: [] }} canConfigure />);
  expect(await screen.findByTestId('topology-telemetry-no-ports')).toHaveTextContent('Port not identified');
});

it('is read-only without configure permission and a blocked arm shows its reason', async () => {
  arms = [telemetryArmFixture({ state: 'blocked', blockedReason: 'credential_changed' })];
  render(<InterfaceTelemetrySettings siteId={OPS.site} nodeId={OPS.node} graph={graph()} canConfigure={false} />);
  expect(await screen.findByTestId(`topology-telemetry-arm-${OPS.arm}`)).toHaveTextContent('Blocked');
  expect(screen.getByTestId(`topology-telemetry-arm-${OPS.arm}`)).toHaveTextContent('credential changed');
  expect(screen.queryByTestId('topology-telemetry-enable')).toBeNull();
  expect(screen.queryByTestId('topology-telemetry-revoke')).toBeNull();
});

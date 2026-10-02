import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TopologyList from './TopologyList';
import { topologyGraphFixture, NODE } from './topologyFixtures';

afterEach(cleanup);

it('lists reported nodes with role and health, and selecting one calls onSelect with a node selection', () => {
  const graph = topologyGraphFixture();
  const onSelect = vi.fn();
  render(<TopologyList graph={graph} onSelect={onSelect} />);
  const row = screen.getByTestId(`topology-node-${NODE}`);
  expect(row).toHaveTextContent('Reported gateway');
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: NODE });
});

it('lists schematic presentation nodes as not identified, distinct from reported roles', () => {
  const graph = topologyGraphFixture();
  graph.presentation.nodes = [{ id: 'schematic-1', meaning: 'missing_default_route', authority: false, label: 'Missing default route' } as never];
  render(<TopologyList graph={graph} onSelect={vi.fn()} />);
  const row = screen.getByTestId('topology-node-schematic-1');
  expect(row.closest('tr')).toHaveTextContent('Not identified');
});

it('lists relationships with resolved endpoint labels and selecting one calls onSelect with an edge selection', () => {
  const graph = topologyGraphFixture();
  const other = { ...graph.nodes[0], id: 'other-node', label: 'Other device' };
  graph.nodes.push(other);
  graph.relationships = [{ id: 'edge-1', kind: 'physical_link', meaning: 'connects', sourceNodeId: NODE, targetNodeId: other.id, evidence: { classes: ['observed'], methods: [], count: '1', lastObservedAt: null }, freshness: 'fresh', health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [], freshness: 'unknown' } } as never];
  const onSelect = vi.fn();
  render(<TopologyList graph={graph} onSelect={onSelect} />);
  const edgeButton = screen.getByTestId('topology-edge-edge-1');
  expect(edgeButton.closest('tr')).toHaveTextContent('Reported gateway');
  expect(edgeButton.closest('tr')).toHaveTextContent('Other device');
  fireEvent.click(edgeButton);
  expect(onSelect).toHaveBeenCalledWith({ kind: 'edge', id: 'edge-1' });
});

it('shows outside-this-projection for an edge endpoint that is not in the visible node set', () => {
  const graph = topologyGraphFixture();
  graph.relationships = [{ id: 'edge-2', kind: 'logical_link', meaning: 'routes', sourceNodeId: NODE, targetNodeId: 'not-in-graph', evidence: { classes: ['observed'], methods: [], count: '1', lastObservedAt: null }, freshness: 'fresh', health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [], freshness: 'unknown' } } as never];
  render(<TopologyList graph={graph} onSelect={vi.fn()} />);
  expect(screen.getByTestId('topology-edge-edge-2').closest('tr')).toHaveTextContent('Outside this projection');
});

it('filters the node list case-insensitively by the search prop', () => {
  const graph = topologyGraphFixture();
  const other = { ...graph.nodes[0], id: 'other-node', label: 'Router upstairs' };
  graph.nodes.push(other);
  render(<TopologyList graph={graph} onSelect={vi.fn()} search="ROUTER" />);
  expect(screen.queryByTestId(`topology-node-${NODE}`)).not.toBeInTheDocument();
  expect(screen.getByTestId('topology-node-other-node')).toBeVisible();
});

it('labels a physical edge truthfully and lists hidden connections with a restore action', () => {
  const graph = topologyGraphFixture();
  const other = { ...graph.nodes[0], id: 'other-node', label: 'Desk 12' };
  graph.nodes.push(other);
  graph.relationships = [{ id: 'edge-3', kind: 'attachment', meaning: 'attachment', directness: 'unknown', sourceNodeId: NODE, targetNodeId: other.id, sourceInterfaceId: null, targetInterfaceId: null, evidence: { classes: ['inferred'], methods: ['fdb'], count: '1', lastObservedAt: null }, freshness: 'fresh', health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [], freshness: 'unknown' } } as never];
  const onRestore = vi.fn();
  const item = { id: 'exclusion-1', relationshipId: 'hidden-edge', view: 'physical' as const, reason: 'Lab bench cable', active: true as const,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: null, revokedAt: null, revokedBy: null,
    relationship: { id: 'hidden-edge', kind: 'physical_link', sourceNodeId: 'a', targetNodeId: 'b', sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'observed', lifecycle: 'active' } };
  render(<TopologyList graph={graph} onSelect={vi.fn()} hidden={{ items: [item], canEdit: true, onRestore }} />);
  expect(screen.getByTestId('topology-edge-edge-3')).toHaveTextContent('Attachment');
  expect(screen.getByTestId('topology-edge-edge-3').closest('tr')).toHaveTextContent('Direct connection not established');
  expect(screen.getByTestId('topology-hidden')).toHaveTextContent('Hidden (1)');
  expect(screen.getByTestId('topology-hidden-exclusion-1')).toHaveTextContent('Lab bench cable');
  fireEvent.click(screen.getByTestId('topology-restore-exclusion-1'));
  expect(onRestore).toHaveBeenCalledWith(item);
});

it('names a hidden connection by its two endpoints, not an id prefix', () => {
  const graph = topologyGraphFixture();
  const other = { ...graph.nodes[0], id: 'other-node', label: 'Desk 12' };
  graph.nodes.push(other);
  const item = { id: 'exclusion-1', relationshipId: 'fc7a07c8-0000-4000-8000-000000000000', view: 'physical' as const, reason: 'Lab bench cable', active: true as const,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: null, revokedAt: null, revokedBy: null,
    relationship: { id: 'fc7a07c8-0000-4000-8000-000000000000', kind: 'physical_link', sourceNodeId: NODE, targetNodeId: other.id, sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'observed', lifecycle: 'active' } };
  render(<TopologyList graph={graph} onSelect={vi.fn()} hidden={{ items: [item], canEdit: false, onRestore: vi.fn() }} />);
  const row = screen.getByTestId('topology-hidden-exclusion-1');
  expect(row).toHaveTextContent(`${graph.nodes[0].label} ↔ Desk 12`);
  expect(row).not.toHaveTextContent('fc7a07c8');
});
it('shows hidden connections to a read-only user without a restore action', () => {
  const item = { id: 'exclusion-1', relationshipId: 'hidden-edge', view: 'physical' as const, reason: 'Lab bench cable', active: true as const,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: null, revokedAt: null, revokedBy: null,
    relationship: { id: 'hidden-edge', kind: 'physical_link', sourceNodeId: 'a', targetNodeId: 'b', sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'observed', lifecycle: 'active' } };
  render(<TopologyList graph={topologyGraphFixture()} onSelect={vi.fn()} hidden={{ items: [item], canEdit: false, onRestore: vi.fn() }} />);
  expect(screen.getByTestId('topology-hidden-exclusion-1')).toBeVisible();
  expect(screen.queryByTestId('topology-restore-exclusion-1')).not.toBeInTheDocument();
});

it('shows each device’s address and network and sorts rows by network, then name (grouped overview)', () => {
  const graph = topologyGraphFixture();
  const base = graph.nodes[0]!;
  const inv = (name: string, address: string) => ({ source: 'device' as const, name, addresses: [address], mac: null, vendor: null, model: null, os: null, type: 'workstation',
    presence: { state: 'online' as const, source: 'agent' as const, agentStatus: 'online', lastSeenAt: null } });
  const zed = { ...base, id: '10000000-0000-4000-8000-0000000000a1', kind: 'endpoint' as const, label: 'ZED', inventory: inv('ZED', '10.1.2.9') };
  const amy = { ...base, id: '10000000-0000-4000-8000-0000000000a2', kind: 'endpoint' as const, label: 'AMY', inventory: inv('AMY', '10.1.2.8') };
  graph.nodes = [zed, amy];
  graph.relationships = [];
  graph.presentation = { edges: [], nodes: [{ id: 'presentation:overview:s:net-a', view: 'overview', role: 'network_group', label: '10.1.2.0/24', memberCount: 2, frontierToken: 't', authority: false,
    group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: 'lan', prefix: '10.1.2.0/24', address: null, gatewayAddresses: [], conflict: false, observerCount: 2,
      members: [{ nodeId: zed.id, placement: 'observed', primary: true, stale: false }, { nodeId: amy.id, placement: 'observed', primary: true, stale: false }], canonicalNodeIds: [] } }] };
  render(<TopologyList graph={graph} onSelect={() => {}} />);
  const zedRow = screen.getByTestId(`topology-node-${zed.id}`).closest('tr')!;
  expect(zedRow).toHaveTextContent('10.1.2.9');
  expect(zedRow).toHaveTextContent('10.1.2.0/24');
  const names = [...screen.getByTestId('topology-list').querySelectorAll('tbody tr button[data-testid^="topology-node-"]')].map((b) => b.textContent);
  expect(names.indexOf('AMY')).toBeLessThan(names.indexOf('ZED'));
});

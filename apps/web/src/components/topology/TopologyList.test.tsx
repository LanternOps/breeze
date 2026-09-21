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

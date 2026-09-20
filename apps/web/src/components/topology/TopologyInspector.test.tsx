import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TopologyInspector from './TopologyInspector';
import { topologyGraphFixture, NODE, ASSET } from './topologyFixtures';
afterEach(cleanup);

it('renders reported entity detail, focuses the heading and offers a live diagnose action', () => {
  const graph = topologyGraphFixture();
  const onDiagnose = vi.fn(), onClose = vi.fn(), onExpand = vi.fn();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={onDiagnose} onClose={onClose} onExpand={onExpand} />);
  expect(screen.getByRole('heading', { name: 'Reported gateway' })).toHaveFocus();
  expect(screen.queryByText(/schematic/i)).not.toBeInTheDocument();
  expect(screen.getByText(/observed/)).toBeVisible();
  expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByTestId('topology-diagnose'));
  expect(onDiagnose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTestId('topology-inspector-close'));
  expect(onClose).toHaveBeenCalledOnce();
});

it('disables diagnose and explains why when the caller says diagnostics are unavailable', () => {
  const graph = topologyGraphFixture();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose={false} onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(screen.getByTestId('topology-diagnose')).toBeDisabled();
  expect(screen.getByText(/Diagnostics are unavailable/)).toBeVisible();
});

it('presentation-only schematic nodes explain themselves and never offer diagnose', () => {
  const graph = topologyGraphFixture();
  graph.presentation.nodes = [{ id: 'schematic-1', meaning: 'missing_default_route', authority: false } as never];
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'schematic-1' }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(screen.getByText('This diagram element explains missing evidence. It is not discovered hardware and cannot run diagnostics.')).toBeVisible();
  expect(screen.queryByTestId('topology-diagnose')).not.toBeInTheDocument();
});

it('links reported inventory bindings out to the device record, never to a manual node', () => {
  const graph = topologyGraphFixture();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  const link = screen.getByRole('link', { name: 'Open inventory details' });
  expect(link).toHaveAttribute('href', `/devices/network/${ASSET}`);
});

it('toggles pin state through the caller-provided handler and reflects pressed state', () => {
  const graph = topologyGraphFixture();
  const onPin = vi.fn();
  const { rerender } = render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onPin={onPin} pinned={false} />);
  const pinButton = screen.getByTestId('topology-pin');
  expect(pinButton).toHaveAttribute('aria-pressed', 'false');
  expect(pinButton).toHaveTextContent('Pin');
  fireEvent.click(pinButton);
  expect(onPin).toHaveBeenCalledOnce();
  rerender(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onPin={onPin} pinned />);
  expect(screen.getByTestId('topology-pin')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('topology-pin')).toHaveTextContent('Unpin');
});

it('closes on Escape from within the panel', () => {
  const graph = topologyGraphFixture();
  const onClose = vi.fn();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={onClose} onExpand={vi.fn()} />);
  fireEvent.keyDown(screen.getByTestId('topology-inspector'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

it('renders nothing when the selected id is not present in the graph', () => {
  const graph = topologyGraphFixture();
  const { container } = render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'missing' }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

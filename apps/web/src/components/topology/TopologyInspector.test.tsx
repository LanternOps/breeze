import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopologyInspector from './TopologyInspector';
import { topologyGraphFixture, NODE, ASSET, SITE } from './topologyFixtures';
import { EXCLUSION, FDB, fdbDetail, fdbEvidence, fdbRelationship } from './physicalFixtures';
import { fetchWithAuth } from '../../stores/auth';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
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

describe('physical relationship detail', () => {
  beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });
  it('reads relationship detail and evidence for the selected edge and offers the exclusion action to editors', async () => {
    const graph = topologyGraphFixture();
    graph.relationships = [fdbRelationship()];
    vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/evidence') ? fdbEvidence() : fdbDetail())));
    render(<TopologyInspector graph={graph} siteId={SITE} view="physical" selection={{ kind: 'edge', id: FDB }} canDiagnose={false} onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('topology-source-port')).toHaveTextContent('port-24');
    expect(screen.getByTestId('topology-directness')).toHaveTextContent('Direct connection not established');
    expect(await screen.findByTestId(`topology-observation-${EXCLUSION}`)).toBeVisible();
    expect(screen.getByTestId('topology-exclusion-hide')).toBeInTheDocument();
    const urls = vi.mocked(fetchWithAuth).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(expect.arrayContaining([`/topology/sites/${SITE}/relationships/${FDB}`, expect.stringContaining(`/topology/sites/${SITE}/relationships/${FDB}/evidence`)]));
    expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });
});

describe('Explain this in the inspector (M4 Task 5)', () => {
  const explain = { canApprove: true, onInvestigation: vi.fn(), onRun: vi.fn(), onEvidenceSelect: vi.fn() };
  beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

  it('offers Explain for a canonical selection when AI is available, and keeps the deterministic Diagnose action', () => {
    render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: NODE }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} explain={explain} />);
    expect(screen.getByTestId('topology-explain')).toBeEnabled();
    expect(screen.getByTestId('topology-diagnose')).toBeEnabled();
    // Rendering the panel never starts a model call.
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('offers no Explain when AI is unavailable (no explain wiring) or for a schematic element', () => {
    const { unmount } = render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: NODE }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.queryByTestId('topology-explain')).toBeNull();
    unmount();
    const graph = topologyGraphFixture();
    graph.presentation.nodes = [{ id: 'schematic-1', meaning: 'missing_default_route', authority: false } as never];
    render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'schematic-1' }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} explain={explain} />);
    expect(screen.queryByTestId('topology-explain')).toBeNull();
  });
});

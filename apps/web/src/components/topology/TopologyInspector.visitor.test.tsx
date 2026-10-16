import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TopologyInspector from './TopologyInspector';
import { topologyGraphFixture } from './topologyFixtures';
import { presenceVisitor } from './presenceFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
afterEach(cleanup);

const open = (macCorroborated: boolean, extra: Record<string, unknown> = {}) => {
  const visitor = presenceVisitor(1, { macCorroborated });
  const onClose = vi.fn();
  render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: visitor.id }} visitor={visitor} siteName="Lakeside" canDiagnose onDiagnose={vi.fn()}
    onClose={onClose} onExpand={vi.fn()} onPin={vi.fn()} siteId="11111111-1111-4111-8111-111111111111" view="overview"
    operations={{ interfaceHealth: true, monitoring: true, canConfigure: true }} {...extra} />);
  return onClose;
};

it('explains a visitor: where it is assigned and which network it reports, and focuses the heading', () => {
  open(false);
  expect(screen.getByRole('heading', { name: 'LAPTOP-LOV-01' })).toHaveFocus();
  expect(screen.getByText("Assigned to Main Office. Reports Lakeside's network 10.1.5.0/24 via 10.1.5.1. The gateway matches Lakeside's devices.")).toBeVisible();
});

it('adds the router MAC when the gateway is MAC-corroborated', () => {
  open(true);
  expect(screen.getByText("Assigned to Main Office. Reports Lakeside's network 10.1.5.0/24 via 10.1.5.1. The gateway matches Lakeside's devices, including its router MAC.")).toBeVisible();
});

it('offers no Diagnose, Pin, Expand, Explain or operations for a visitor, only Close', () => {
  const onClose = open(false);
  for (const id of ['topology-diagnose', 'topology-pin', 'topology-expand', 'topology-explain-not-configured']) expect(screen.queryByTestId(id)).toBeNull();
  expect(screen.queryByText(/Diagnostics are unavailable/)).toBeNull();
  fireEvent.click(screen.getByTestId('topology-inspector-close'));
  expect(onClose).toHaveBeenCalledOnce();
});

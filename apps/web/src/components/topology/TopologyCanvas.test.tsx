import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { TopologyRender } from './renderProjection';

// jsdom has no 2D canvas, so Cytoscape's renderer cannot run here. A chainable stand-in records the options the
// canvas constructs Cytoscape with; every other call returns the stand-in again (collections are empty).
const created: Record<string, unknown>[] = [];
vi.mock('cytoscape', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_target, key) => key === 'length' ? 0 : key === Symbol.iterator ? [][Symbol.iterator].bind([]) : key === 'then' ? undefined
      : key === 'batch' ? (fn: () => void) => fn() : key === 'forEach' || key === 'map' ? () => [] : chain,
    apply: () => chain,
  });
  return { default: vi.fn((options: Record<string, unknown>) => { created.push(options); return chain; }) };
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); created.length = 0; });

const empty: TopologyRender = { nodes: [], edges: [], grouped: false, hiddenNetworkCount: 0, hiddenDeviceCount: 0,
  site: {} as TopologyRender['site'] };

it('never runs Cytoscape\'s default grid layout: positions are always set by the canvas itself (#8113)', async () => {
  const { default: TopologyCanvas } = await import('./TopologyCanvas');
  render(<TopologyCanvas render={empty} positions={[]} boxes={[]} editable={false} onSelect={() => {}} onMove={() => {}} fitRef={{ current: null }} fitKey="overview" />);
  expect(created).toHaveLength(1);
  // Cytoscape runs `layout` once at construction and defaults it to `grid` when it has a container. The grid
  // sizes itself from the container, and a container it cannot measure (NaN size, e.g. no longer in the document) throws
  // `Cannot read properties of undefined (reading 'h')` from GridLayout.run. The `null` layout reads no size.
  expect(created[0]).toMatchObject({ elements: [], layout: { name: 'null' } });
});

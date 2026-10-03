import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import NodeChipOverlay, { overviewChips } from './NodeChipOverlay';
import type { RenderNode } from './renderProjection';

afterEach(cleanup);

const chips = [
  { id: 'gw', title: '10.1.2.100', detail: 'Gateway for 22 devices', glyph: 'router' as const },
  { id: 'loose', title: 'NAS-01', detail: null, glyph: 'nas' as const },
];

it('names each zoomed-out gateway chip by its label and detail, and selects its node', async () => {
  const onSelect = vi.fn();
  render(<NodeChipOverlay chips={chips} visible selectedId="gw" onSelect={onSelect} />);
  const gateway = screen.getByRole('button', { name: '10.1.2.100, Gateway for 22 devices' });
  expect(gateway).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'NAS-01' })).toHaveAttribute('aria-pressed', 'false');
  await userEvent.click(gateway);
  expect(onSelect).toHaveBeenCalledWith('gw');
});

it('is out of the accessibility tree while the map shows tiles', () => {
  render(<NodeChipOverlay chips={chips} visible={false} onSelect={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
});

const node = (id: string, kind: RenderNode['kind'], parent?: string): RenderNode => ({ id, label: id, detail: null, kind, glyph: 'router', ...(parent ? { parent } : {}),
  presence: null, agentPresence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: null, memberCount: 0, address: null, note: null, sharedWith: 0 });

it('gives chips only to a grouped overview: a flat logical or physical view keeps its tiles at every zoom', () => {
  const nodes = [node('card', 'group'), node('member', 'device', 'card'), node('gw', 'gateway'), node('loose', 'device'), node('far', 'outside')];
  expect(overviewChips({ grouped: true, nodes }).map((chip) => chip.id)).toEqual(['gw', 'loose']);
  // ~1,000 loose tiles in a flat view must not become ~1,000 HTML chips re-measured every frame.
  const flat = Array.from({ length: 1000 }, (_, index) => node(`n${index}`, 'device'));
  expect(overviewChips({ grouped: false, nodes: flat })).toEqual([]);
});

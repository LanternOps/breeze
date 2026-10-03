import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import NodeChipOverlay from './NodeChipOverlay';

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

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import CardSummaryOverlay from './CardSummaryOverlay';

afterEach(cleanup);

const cards = [
  { id: 'lan', title: '10.1.2.0/24', detail: '85 devices · via 10.1.2.100',
    summary: { total: 85, agentsOnline: 12, agentsOffline: 20, sections: [{ section: 'network' as const, count: 7 }, { section: 'computers' as const, count: 45 }] } },
  { id: 'iot', title: '10.1.9.0/24', detail: null, summary: { total: 3, agentsOnline: 0, agentsOffline: 0, sections: [{ section: 'other' as const, count: 3 }] } },
];

it('gives every summary an accessible name that reads title, roles and agent presence in order', () => {
  render(<CardSummaryOverlay cards={cards} visible onZoom={() => {}} />);
  expect(screen.getByRole('button', { name: '10.1.2.0/24, 85 devices · via 10.1.2.100. Network equipment 7, Computers 45. 12 agents online · 20 offline. Zoom in to see the devices' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^10\.1\.9\.0\/24\. Other devices 3\. No Breeze agents\./ })).toBeInTheDocument();
});

it('zooms into the card a summary stands for', async () => {
  const onZoom = vi.fn();
  render(<CardSummaryOverlay cards={cards} visible onZoom={onZoom} />);
  await userEvent.click(screen.getByRole('button', { name: /^10\.1\.2\.0\/24/ }));
  expect(onZoom).toHaveBeenCalledWith('lan');
});

it('is out of the accessibility tree while the map shows tiles', () => {
  render(<CardSummaryOverlay cards={cards} visible={false} onZoom={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('keeps title, subtitle and presence in a compact summary; only the role chips give way', () => {
  render(<CardSummaryOverlay cards={cards} visible onZoom={() => {}} />);
  const box = screen.getAllByTestId('topology-card-summary')[0]!.parentElement!;
  box.dataset.density = 'compact';
  const hiddenWhenCompact = (text: string) => screen.getAllByText(text)[0]!.closest('[class*="group-data-[density=compact]:hidden"]') !== null;
  expect(hiddenWhenCompact('10.1.2.0/24')).toBe(false);
  expect(hiddenWhenCompact('85 devices · via 10.1.2.100')).toBe(false);
  expect(hiddenWhenCompact('12 agents online · 20 offline')).toBe(false);
  expect(hiddenWhenCompact('Computers')).toBe(true);
  expect(document.querySelector('[class*="density=minimal"]')).toBeNull();
});

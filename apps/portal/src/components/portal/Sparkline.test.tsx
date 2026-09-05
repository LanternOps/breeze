// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Sparkline } from './Sparkline';

it('renders a labelled inline SVG without a chart dependency', () => {
  render(<Sparkline values={[40, 55, 70, 82]} label="Security score trend" />);
  const svg = screen.getByTestId('portal-sparkline');
  expect(svg.tagName.toLowerCase()).toBe('svg');
  expect(svg.getAttribute('aria-label')).toBe('Security score trend');
  expect(svg.querySelector('polyline')).not.toBeNull();
});

it('draws in the service green by default rather than borrowing body ink', () => {
  render(<Sparkline values={[40, 55, 70, 82]} label="Security score trend" />);
  expect(screen.getByTestId('portal-sparkline').getAttribute('class')).toContain('text-primary');
});

it('takes the tone of the reading when one is passed in', () => {
  render(<Sparkline values={[82, 70, 55, 40]} label="Security score trend" tone="destructive" />);
  const svg = screen.getByTestId('portal-sparkline');
  expect(svg.getAttribute('class')).toContain('text-destructive-on-tint');
  expect(svg.getAttribute('class')).not.toContain('text-primary');
});

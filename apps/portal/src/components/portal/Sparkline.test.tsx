// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline';

it('renders a labelled inline SVG without a chart dependency', () => {
  render(<Sparkline values={[40, 55, 70, 82]} label="Security score trend" />);
  const svg = screen.getByTestId('portal-sparkline');
  expect(svg.tagName.toLowerCase()).toBe('svg');
  expect(svg.getAttribute('aria-label')).toBe('Security score trend');
  expect(svg.querySelector('polyline')).not.toBeNull();
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ComponentStatePill from './ComponentStatePill';

describe('ComponentStatePill', () => {
  it.each([
    ['ok', 'optimal', 'text-success'],
    ['critical', 'degraded', 'text-destructive'],
    ['warning', 'rebuilding', 'text-warning'],
    ['unknown', 'unknown', 'text-muted-foreground'],
  ] as const)('%s uses server health for %s', (health, state, color) => {
    render(<ComponentStatePill health={health} state={state} />);
    expect(screen.getByTestId('hardware-state-pill')).toHaveClass(color);
    expect(screen.getByTestId('hardware-state-pill')).toHaveTextContent(state);
  });
  it('greys stale evidence without rewriting its recorded state', () => {
    render(<ComponentStatePill health="critical" state="failed" stale predictiveFailure />);
    expect(screen.getByTestId('hardware-state-pill')).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('hardware-state-pill')).toHaveTextContent('failed');
    expect(screen.getByLabelText('Predictive failure')).toBeInTheDocument();
  });
  it('supports the separately named rollup pill', () => {
    render(<ComponentStatePill health="ok" testId="hardware-rollup-pill" title="2 disks" />);
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveAttribute('title', '2 disks');
  });
});

import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useHydrated } from './useHydrated';

function Probe() {
  return <span data-testid="probe">{String(useHydrated())}</span>;
}

describe('useHydrated (#6391)', () => {
  it('is false while server-rendering', () => {
    expect(renderToString(<Probe />)).toContain('false');
  });

  it('is true in the browser', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });
});

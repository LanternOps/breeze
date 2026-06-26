import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./S1ThreatList', () => ({ default: () => <div data-testid="s1-list" /> }));
vi.mock('./HuntressIncidentList', () => ({ default: () => <div data-testid="huntress-list" /> }));

import EdrPage from './EdrPage';

describe('EdrPage', () => {
  it('defaults to the SentinelOne tab and switches to Huntress', () => {
    render(<EdrPage />);
    expect(screen.getByTestId('s1-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edr-tab-huntress'));
    expect(screen.getByTestId('huntress-list')).toBeInTheDocument();
    expect(window.location.hash).toBe('#huntress');
  });
});

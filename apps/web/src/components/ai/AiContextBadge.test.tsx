import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiContextBadge from './AiContextBadge';

describe('AiContextBadge', () => {
  it('badge shows the record label', () => {
    render(<AiContextBadge context={{ type: 'record', kind: 'ticket', id: 't1', label: 'T-42 Printer offline' }} />);
    expect(screen.getByText('T-42 Printer offline')).toBeInTheDocument();
  });
  it('falls back when the record label is missing', () => {
    render(<AiContextBadge context={{ type: 'record', kind: 'ticket', id: 't1' }} />);
    expect(screen.getByText('Record')).toBeInTheDocument();
  });
});

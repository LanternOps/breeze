import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import ChordIndicator from './ChordIndicator';
import { i18n } from '../../lib/i18n';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('ChordIndicator', () => {
  it('renders nothing with no chord pending', () => {
    render(<ChordIndicator prefix={null} />);
    expect(screen.queryByTestId('chord-indicator')).toBeNull();
  });

  it('shows the pressed prefix and the go-to keys it can complete', () => {
    render(<ChordIndicator prefix="g" />);
    const el = screen.getByTestId('chord-indicator');
    expect(el).toHaveTextContent('G');
    expect(el).toHaveTextContent('Go to');
    expect(within(el).getByText('Tickets')).toBeInTheDocument();
    expect(el).toHaveAttribute('role', 'status');
  });

  it('shows the create targets for c', () => {
    render(<ChordIndicator prefix="c" />);
    const el = screen.getByTestId('chord-indicator');
    expect(el).toHaveTextContent('Create');
    expect(within(el).getByText('New ticket')).toBeInTheDocument();
    expect(within(el).getByText('New quote')).toBeInTheDocument();
  });
});

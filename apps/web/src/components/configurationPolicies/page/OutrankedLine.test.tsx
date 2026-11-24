import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import OutrankedLine from './OutrankedLine';
import type { PolicyPrecedence } from './precedenceApi';

const counts = (outranked: number, reached = 40): PolicyPrecedence => ({
  capped: false,
  features: { patch: { reached, outranked } },
});

describe('OutrankedLine (#12472)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('the feature shows Outranked on N devices', () => {
    render(<OutrankedLine featureType="patch" state="set_here" precedence={counts(3)} />);
    const line = screen.getByTestId('config-policy-outranked');
    expect(line).toHaveTextContent('Outranked on 3 devices');
    // The count is about the devices the viewer can see.
    expect(line).toHaveTextContent('devices you can see');
    expect(line).not.toHaveTextContent('Too many devices');
  });

  it('one device reads in the singular', () => {
    render(<OutrankedLine featureType="patch" state="from_parent" precedence={counts(1)} />);
    expect(screen.getByTestId('config-policy-outranked')).toHaveTextContent('Outranked on 1 device');
  });

  it('capped says to open a device', () => {
    render(<OutrankedLine featureType="patch" state="set_here" precedence={{ capped: true }} />);
    const line = screen.getByTestId('config-policy-outranked');
    expect(line).toHaveAttribute('data-state', 'capped');
    expect(line).toHaveTextContent('Too many devices to count');
    expect(line).toHaveTextContent("Open a device's Configuration tab");
    // Never a number: capped is not zero.
    expect(line.textContent).not.toMatch(/\d/);
  });

  it('zero outranked shows nothing', () => {
    const { container } = render(<OutrankedLine featureType="patch" state="set_here" precedence={counts(0)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('an unknown answer (loading or a failed read) shows nothing, never 0 outranked', () => {
    const { container } = render(<OutrankedLine featureType="patch" state="set_here" precedence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a feature the answer does not mention shows nothing', () => {
    const { container } = render(<OutrankedLine featureType="backup" state="set_here" precedence={counts(3)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a feature not in effect here shows nothing, even capped', () => {
    for (const state of ['not_set', 'unavailable'] as const) {
      const { container, unmount } = render(
        <OutrankedLine featureType="patch" state={state} precedence={{ capped: true }} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

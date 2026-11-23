import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppliesToStrip from './AppliesToStrip';
import type { ConfigPolicyAppliesToSummary, ConfigPolicyAppliesToTarget } from './appliesToSummary';
import { i18n } from '../../lib/i18n';

const summary = (over: Partial<ConfigPolicyAppliesToSummary> = {}): ConfigPolicyAppliesToSummary => ({
  assignmentCount: 0,
  allOrganizations: false,
  targets: [],
  childPolicyCount: 0,
  ...over,
});

const target = (
  id: string,
  name: string,
  over: Partial<ConfigPolicyAppliesToTarget> = {},
): ConfigPolicyAppliesToTarget => ({
  assignmentId: id,
  level: 'organization',
  targetId: `t-${id}`,
  name,
  roleFilter: null,
  osFilter: null,
  ...over,
});

describe('AppliesToStrip (#12306)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('absent appliesTo renders unknown, never Not applied', () => {
    const onEdit = vi.fn();
    render(<AppliesToStrip summary={null} status="active" onEdit={onEdit} />);
    const strip = screen.getByTestId('config-policy-applies-to-strip');
    expect(strip).toHaveTextContent('Applies to');
    expect(strip).toHaveTextContent('—');
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
    expect(screen.queryByTestId('config-policy-applies-to-in-use')).toBeNull();
    expect(strip).not.toHaveTextContent(/Not applied/i);
    fireEvent.click(screen.getByTestId('config-policy-applies-to-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('strip never says Not applied when assignmentCount > 0', () => {
    render(<AppliesToStrip summary={summary({ assignmentCount: 1 })} status="active" onEdit={vi.fn()} />);
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
    expect(screen.getByTestId('config-policy-applies-to-more')).toHaveTextContent('+1');
    expect(screen.getByTestId('config-policy-applies-to-strip')).not.toHaveTextContent(/Not applied/i);
  });

  it('a parent with children reads In use through N policies', () => {
    render(<AppliesToStrip summary={summary({ childPolicyCount: 2 })} status="active" onEdit={vi.fn()} />);
    expect(screen.getByTestId('config-policy-applies-to-in-use')).toHaveTextContent('In use through 2 policies');
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
  });

  it('Not applied shows the warning and an Assign button that opens the editor', () => {
    const onEdit = vi.fn();
    render(<AppliesToStrip summary={summary()} status="active" onEdit={onEdit} />);
    const warning = screen.getByTestId('config-policy-applies-to-not-applied');
    expect(warning).toHaveTextContent('Not applied to any device');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByTestId('config-policy-applies-to-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('config-policy-applies-to-assign'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders each target with its name, All organizations for a partner row, and its filter badges', () => {
    render(
      <AppliesToStrip
        summary={summary({
          assignmentCount: 2,
          allOrganizations: true,
          targets: [
            target('p', '', { level: 'partner', name: null }),
            target('o', 'Acme', { osFilter: ['windows'] }),
          ],
        })}
        status="active"
        onEdit={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('config-policy-applies-to-target');
    expect(rows.map((r) => r.querySelector('[data-testid="config-policy-applies-to-target-name"]')?.textContent)).toEqual([
      'All organizations',
      'Acme',
    ]);
    expect(rows[1]).toHaveTextContent('Windows');
    expect(screen.queryByTestId('config-policy-applies-to-more')).toBeNull();
    expect(screen.getByTestId('config-policy-applies-to-edit')).toBeTruthy();
  });

  it('long target lists truncate to three names and +N', () => {
    render(
      <AppliesToStrip
        summary={summary({
          assignmentCount: 7,
          targets: [target('a', 'Acme'), target('b', 'Birch'), target('c', 'Cedar')],
        })}
        status="active"
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('config-policy-applies-to-target')).toHaveLength(3);
    expect(screen.getByTestId('config-policy-applies-to-more')).toHaveTextContent('+4');
  });

  it('an inactive unapplied policy reads Not applied yet, not the warning', () => {
    const onEdit = vi.fn();
    render(<AppliesToStrip summary={summary()} status="inactive" onEdit={onEdit} />);
    const state = screen.getByTestId('config-policy-applies-to-not-applied');
    expect(state).toHaveAttribute('data-tone', 'neutral');
    expect(state).toHaveTextContent('Not applied yet');
    expect(state).not.toHaveTextContent('Not applied to any device');
    fireEvent.click(screen.getByTestId('config-policy-applies-to-assign'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('an archived policy shows no not-applied state', () => {
    render(<AppliesToStrip summary={summary()} status="archived" onEdit={vi.fn()} />);
    expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
    expect(screen.queryByTestId('config-policy-applies-to-assign')).toBeNull();
    expect(screen.getByTestId('config-policy-applies-to-strip')).toHaveTextContent('—');
    expect(screen.getByTestId('config-policy-applies-to-edit')).toBeTruthy();
  });

  describe('device count (#12467)', () => {
    const applied = summary({ assignmentCount: 1, targets: [target('a', 'Acme')] });

    it('the strip shows the direct device count when reach is known', () => {
      render(<AppliesToStrip summary={applied} status="active" onEdit={vi.fn()} reach={{ direct: 12, throughChildren: 4, organizations: 2 }} />);
      expect(screen.getByTestId('config-policy-applies-to-reach')).toHaveTextContent('12 devices');
    });

    it('a partial count reads at least N', () => {
      render(<AppliesToStrip summary={applied} status="active" onEdit={vi.fn()} reach={{ direct: 12, throughChildren: 0, organizations: 2, partial: true }} />);
      expect(screen.getByTestId('config-policy-applies-to-reach')).toHaveTextContent('At least 12 devices');
    });

    it('zero visible devices on an applied policy is not Not applied', () => {
      render(<AppliesToStrip summary={applied} status="active" onEdit={vi.fn()} reach={{ direct: 0, throughChildren: 0, organizations: 0 }} />);
      expect(screen.getByTestId('config-policy-applies-to-reach')).toHaveTextContent('No devices you can see');
      expect(screen.queryByTestId('config-policy-applies-to-not-applied')).toBeNull();
    });

    it('a parent counts the devices it reaches through its children', () => {
      render(
        <AppliesToStrip summary={summary({ childPolicyCount: 2 })} status="active" onEdit={vi.fn()} reach={{ direct: 0, throughChildren: 148, organizations: 3 }} />,
      );
      expect(screen.getByTestId('config-policy-applies-to-reach')).toHaveTextContent('148 devices');
    });

    it('no count without a reach, and none on an unknown summary', () => {
      const { unmount } = render(<AppliesToStrip summary={applied} status="active" onEdit={vi.fn()} reach={null} />);
      expect(screen.queryByTestId('config-policy-applies-to-reach')).toBeNull();
      unmount();
      render(<AppliesToStrip summary={null} status="active" onEdit={vi.fn()} reach={{ direct: 3, throughChildren: 0, organizations: 1 }} />);
      expect(screen.queryByTestId('config-policy-applies-to-reach')).toBeNull();
    });
  });

  it('a read-only viewer (no onEdit) gets no Edit or Assign control (#12469)', () => {
    const applied = summary({ assignmentCount: 1, targets: [target('a', 'Acme')] });
    const { unmount } = render(<AppliesToStrip summary={applied} status="active" />);
    expect(screen.queryByTestId('config-policy-applies-to-edit')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<AppliesToStrip summary={summary()} status="active" />);
    expect(screen.getByTestId('config-policy-applies-to-not-applied')).toBeInTheDocument();
    expect(screen.queryByTestId('config-policy-applies-to-assign')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
